import { execSync } from "node:child_process";

// Safety: The fuzzer generates arbitrary data, so we gate each dangerous
// operation on exactly the patterns the detectors look for. This ensures
// arbitrary fuzzed bytes never reach syscalls or mutate prototypes — only
// the specific sentinel values that trigger detection pass through.
//
// Each gate uses strict `===` equality so that CmpLog (trace_cmp) can
// observe the comparison and guide mutations toward the target value.
// Method calls like .includes() and .test() are NOT instrumented by the
// SWC plugin, so the fuzzer would get no guidance from those.
const CMD_INJECT_SENTINEL = "vitiate_cmd_inject";

export function processInput(input: string): void {
  const spaceIndex = input.indexOf(" ");
  if (spaceIndex === -1) return;
  const command = input.slice(0, spaceIndex);
  const arg = input.slice(spaceIndex + 1);
  if (arg.length === 0) return;

  switch (command) {
    case "proto":
      // Only mutate Object.prototype if arg is exactly a known prototype
      // pollution property name. The detector's dictionary injects these
      // tokens; the snapshot-diff detector fires on any property change.
      // Without this gate, arbitrary prototype pollution leaks in non-fuzz
      // mode (where the detector isn't active to auto-restore).
      // Each === is individually instrumented by CmpLog for guidance.
      if (arg === "__proto__" || arg === "constructor" || arg === "prototype") {
        (Object.prototype as Record<string, unknown>)[arg] = true;
      }
      break;
    case "exec":
      // Only pass to execSync if arg is exactly the detector's goal string.
      // The detector hook intercepts and throws VulnerabilityError before
      // the shell executes, but this gate prevents arbitrary commands even
      // if detectors are disabled.
      //
      // No try/catch here: the detector hook throws VulnerabilityError which
      // must propagate as a crash. If the detector isn't active, the shell
      // harmlessly fails with "command not found" for the sentinel string.
      if (arg === CMD_INJECT_SENTINEL) {
        execSync(arg);
      }
      break;
  }
}
