import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";

// Safety: The fuzzer generates arbitrary data, so we gate each dangerous
// operation on exactly the patterns the detectors look for. This ensures
// arbitrary fuzzed bytes never reach syscalls or mutate prototypes - only
// the specific sentinel values that trigger detection pass through.
//
// Each gate uses strict `===` equality so that CmpLog (trace_cmp) can
// observe the comparison and guide mutations toward the target value.
// Method calls like .includes() and .test() are NOT instrumented by the
// SWC plugin, so the fuzzer would get no guidance from those.
const CMD_INJECT_SENTINEL = "vitiate_cmd_inject";
const EVAL_INJECT_SENTINEL = "vitiate_eval_inject";
const SSRF_SENTINEL = "http://169.254.169.254";

// Vulnerable regex: catastrophic backtracking on input like "aaaaaaaaa!"
// The nested quantifier (a+)+ causes exponential backtracking when the
// trailing character doesn't match.
const VULNERABLE_REGEX = /^(a+)+$/;

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
    case "read":
      // Only pass to readFileSync if arg is exactly the path traversal
      // sentinel. The detector hook intercepts and throws VulnerabilityError
      // before the read occurs, but this gate prevents arbitrary file reads
      // even if detectors are disabled.
      if (arg === "/etc/passwd") {
        readFileSync(arg);
      }
      break;
    case "regex":
      // Test the vulnerable regex against the argument. The ReDoS detector
      // measures wall-clock time per regex operation and fires when a single
      // call exceeds the threshold (default 100ms). The input
      // "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!" causes catastrophic backtracking.
      VULNERABLE_REGEX.test(arg);
      break;
    case "fetch":
      // Make an HTTP request to the argument URL. The SSRF detector hooks
      // http.request and checks the hostname against its blocklist.
      // The sentinel URL targets a metadata endpoint (169.254.169.254)
      // which is blocked by default.
      if (arg === SSRF_SENTINEL) {
        http.request(arg);
      }
      break;
    case "eval":
      // Pass the argument to eval(). The unsafe eval detector checks for
      // the goal string in the evaluated code and fires if found.
      if (arg === EVAL_INJECT_SENTINEL) {
        eval(arg);
      }
      break;
  }
}
