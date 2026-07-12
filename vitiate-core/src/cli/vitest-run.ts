/**
 * vitest-wrapper subcommands (fuzz, regression, optimize): build env vars and
 * spawn `vitest run` with the fuzz test filter.
 */
import { spawnSync } from "node:child_process";
import type { InferValue } from "@optique/core/parser";
import { resolveVitestCli, type FuzzOptions } from "../config.js";
import {
  fuzzParser,
  regressionParser,
  optimizeParser,
  parseDetectorsFlag,
} from "./parsers.js";
import { reportVitestMissing } from "./discover.js";

/**
 * Spawn vitest with the given env vars and forwarded args.
 * Used by the fuzz, regression, and optimize subcommands.
 */
function spawnVitestWrapper(
  env: Record<string, string>,
  forwardedArgs: readonly string[],
): void {
  let vitestCli: string;
  try {
    vitestCli = resolveVitestCli();
  } catch {
    reportVitestMissing();
    process.exitCode = 1;
    return;
  }
  const args = [vitestCli, "run", ".fuzz.", ...forwardedArgs];

  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });

  process.exitCode = result.status ?? 1;
}

/**
 * Serialize a `FuzzOptions` object into the `VITIATE_OPTIONS` env var read by
 * the child (see `getCliOptions` in config.ts). Returns an empty record when
 * there is nothing to pass, so callers can `Object.assign` unconditionally.
 */
export function buildOptionsEnv(options: FuzzOptions): Record<string, string> {
  return Object.keys(options).length > 0
    ? { VITIATE_OPTIONS: JSON.stringify(options) }
    : {};
}

/**
 * Build env vars for detectors flag, shared by fuzz/regression/optimize.
 */
function buildDetectorsEnv(
  detectorsSpec: string | undefined,
): Record<string, string> {
  if (detectorsSpec === undefined) return {};
  return buildOptionsEnv({ detectors: parseDetectorsFlag(detectorsSpec) });
}

/**
 * Handle the fuzz subcommand: parse flags, build env vars, spawn vitest.
 */
export function runFuzzSubcommand(parsed: InferValue<typeof fuzzParser>): void {
  const env: Record<string, string> = { VITIATE_FUZZ: "1" };

  if (parsed.fuzzTime !== undefined) {
    env["VITIATE_FUZZ_TIME"] = String(parsed.fuzzTime);
  }
  if (parsed.fuzzExecs !== undefined) {
    env["VITIATE_FUZZ_EXECS"] = String(parsed.fuzzExecs);
  }
  if (parsed.maxCrashes !== undefined) {
    env["VITIATE_MAX_CRASHES"] = String(parsed.maxCrashes);
  }

  // Detectors: merge into VITIATE_OPTIONS
  Object.assign(env, buildDetectorsEnv(parsed.detectors));

  spawnVitestWrapper(env, [...parsed.vitestArgs, ...parsed.positionalArgs]);
}

/**
 * Handle the regression subcommand.
 */
export function runRegressionSubcommand(
  parsed: InferValue<typeof regressionParser>,
): void {
  const env: Record<string, string> = {};
  Object.assign(env, buildDetectorsEnv(parsed.detectors));
  spawnVitestWrapper(env, [...parsed.vitestArgs, ...parsed.positionalArgs]);
}

/**
 * Handle the optimize subcommand.
 */
export function runOptimizeSubcommand(
  parsed: InferValue<typeof optimizeParser>,
): void {
  const env: Record<string, string> = { VITIATE_OPTIMIZE: "1" };
  const options: FuzzOptions = {};
  if (parsed.detectors !== undefined) {
    options.detectors = parseDetectorsFlag(parsed.detectors);
  }
  if (parsed.timeout !== undefined) {
    // CLI flags use seconds (matching libFuzzer convention); internal
    // FuzzOptions use milliseconds. 0 stays 0, disabling the watchdog.
    options.timeoutMs = parsed.timeout * 1000;
  }
  Object.assign(env, buildOptionsEnv(options));
  // Pin the forks pool so optimize's replay/minimization runs on a forked
  // pool worker's main thread (`isMainThread === true`), letting the replay
  // watchdog arm - and `--timeout` be honored - regardless of the user's
  // configured pool (see `makeReplayRunner` in fuzz.ts). An explicit user
  // `--pool` in the passthrough args wins: vitest's CLI rejects a repeated
  // `--pool`, so the pin is only added when the user did not set one. forks
  // is vitest's default, so this is a no-op for the common case.
  const forwardedArgs = [...parsed.vitestArgs, ...parsed.positionalArgs];
  const userSetPool = forwardedArgs.some(
    (arg) => arg === "--pool" || arg.startsWith("--pool="),
  );
  spawnVitestWrapper(
    env,
    userSetPool ? forwardedArgs : ["--pool=forks", ...forwardedArgs],
  );
}
