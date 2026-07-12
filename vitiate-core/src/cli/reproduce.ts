/**
 * reproduce subcommand: replay a single input file once through a fuzz target
 * and exit with the target's status.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { InferValue } from "@optique/core/parser";
import escapeStringRegexp from "escape-string-regexp";
import {
  getProjectRoot,
  resolveVitestCli,
  type FuzzOptions,
} from "../config.js";
import { reproduceParser } from "./parsers.js";
import { discoverFuzzTests, reportVitestMissing } from "./discover.js";
import { buildOptionsEnv } from "./vitest-run.js";
import { DEFAULT_ERROR_EXITCODE } from "./libfuzzer.js";

/**
 * Default per-execution replay timeout (seconds) for the `reproduce`
 * subcommand when `-timeout` is omitted. Without it the single-input replay
 * runs with no vitiate watchdog and a hung input is bounded only by vitest's
 * `testTimeout` (which cannot interrupt a synchronous loop). Defaulting arms
 * the watchdog so any hang is bounded by its `_exit` fallback.
 *
 * Sized for interactive single-input replay, not libFuzzer's batch `-timeout`
 * default (1200s): a fuzz-target execution is sub-millisecond by construction,
 * so 30s never false-positives on a real terminating input while still
 * surfacing a hang to a waiting human quickly. A synchronous hang is
 * interrupted at ~this value; an async idle-await hang - which V8
 * `TerminateExecution` cannot interrupt - surfaces at the watchdog's `_exit`
 * fallback, roughly `5x` this value (the engine's `exit_timeout_multiplier`).
 * Pass `-timeout 1200` for libFuzzer parity or `-timeout 0` to disable.
 */
export const DEFAULT_REPRODUCE_TIMEOUT_SECONDS = 30;

/**
 * Resolve the `reproduce` replay timeout (milliseconds) from the parsed
 * `-timeout` flag (seconds). Omitted arms the watchdog at the interactive
 * default ({@link DEFAULT_REPRODUCE_TIMEOUT_SECONDS}); an explicit value wins;
 * `0` stays `0` and disables the watchdog.
 *
 * :param timeoutSeconds: the parsed `-timeout` value in seconds, or undefined.
 * :returns: the timeout in milliseconds for `FuzzOptions.timeoutMs`.
 */
export function resolveReproduceTimeoutMs(
  timeoutSeconds: number | undefined,
): number {
  return (timeoutSeconds ?? DEFAULT_REPRODUCE_TIMEOUT_SECONDS) * 1000;
}

/**
 * Handle the reproduce subcommand: replay a single input file once through a
 * fuzz target and exit with the target's status (0 clean, non-zero on crash).
 *
 * Runs through vitest (single process, no supervisor/shmem) because the fuzz
 * target is only reachable inside the `fuzz()` test closure. The input path is
 * handed to the worker via `VITIATE_CLI_IPC` and replayed by the regression
 * path (see `getReproduceInputFile` in fuzz.ts).
 */
export async function runReproduceSubcommand(
  parsed: InferValue<typeof reproduceParser>,
): Promise<void> {
  const inputPath = path.resolve(parsed.inputFile);
  if (!existsSync(inputPath)) {
    process.stderr.write(
      `vitiate: error: input file not found: ${parsed.inputFile}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Resolve exactly one target test.
  const discovered = await discoverFuzzTests();
  if (discovered === null) {
    process.exitCode = 1;
    return;
  }
  const matches =
    parsed.testName !== undefined
      ? discovered.filter((t) => t.name === parsed.testName)
      : discovered;

  if (matches.length === 0) {
    const suffix =
      parsed.testName !== undefined ? ` named "${parsed.testName}"` : "";
    process.stderr.write(`vitiate: error: no fuzz test found${suffix}\n`);
    process.exitCode = 1;
    return;
  }
  if (matches.length > 1) {
    process.stderr.write(
      "vitiate: error: multiple fuzz tests found; disambiguate with -test <name>:\n",
    );
    for (const t of matches) {
      process.stderr.write(`  ${t.file} :: ${t.name}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const target = matches[0]!;

  let vitestCli: string;
  try {
    vitestCli = resolveVitestCli();
  } catch {
    reportVitestMissing();
    process.exitCode = 1;
    return;
  }

  // Arm the watchdog by default (an interactive-scale timeout, see
  // DEFAULT_REPRODUCE_TIMEOUT_SECONDS) so a hung single-input replay is bounded
  // by the watchdog's `_exit` fallback rather than relying on vitest's
  // `testTimeout` (which a synchronous loop never yields to). An explicit
  // `-timeout` wins; `-timeout 0` disables the watchdog.
  const options: FuzzOptions = {
    timeoutMs: resolveReproduceTimeoutMs(parsed.timeout),
  };

  const env: Record<string, string> = {
    ...process.env,
    VITIATE_CLI_IPC: JSON.stringify({ reproduceInputFile: inputPath }),
    ...buildOptionsEnv(options),
  };

  const targetFilePath = path.join(getProjectRoot(), target.file);
  const testNamePattern = `^${escapeStringRegexp(target.name)}$`;
  // Pin the forks pool so the replay runs on a child-process main thread
  // (`isMainThread === true`), which is what lets the regression path arm the
  // watchdog (see `makeReplayRunner` in fuzz.ts). Under `pool: 'threads'` the
  // watchdog is disabled because its `_exit` fallback would kill sibling test
  // threads - but reproduce is a one-shot single-input replay in a disposable
  // process with no siblings, so forcing forks is safe and makes the default
  // timeout apply regardless of the user's configured pool. forks is vitest's
  // default, so this is a no-op for the common case.
  const result = spawnSync(
    process.execPath,
    [
      vitestCli,
      "run",
      targetFilePath,
      "--test-name-pattern",
      testNamePattern,
      "--pool=forks",
    ],
    { env, stdio: "inherit" },
  );

  // Match libFuzzer's single-input reproduce contract: a clean replay exits 0,
  // and any reproduced failure (the one input crashed / tripped a detector /
  // timed out) exits with the crash code. Since exactly one input runs through
  // one test, a non-zero vitest status is the reproduced bug; we do not try to
  // separate a timeout here (that distinction lives in the libfuzzer supervisor).
  process.exitCode = result.status === 0 ? 0 : DEFAULT_ERROR_EXITCODE;
}
