/**
 * Standalone CLI: npx vitiate <subcommand> [args...]
 *
 * Subcommands:
 * - **init**: Discover fuzz tests, create seed directories, manage .gitignore.
 * - **fuzz**: Set VITIATE_FUZZ=1, spawn vitest run with fuzz test filter.
 * - **regression**: Spawn vitest run with fuzz test filter (no special env vars).
 * - **optimize**: Set VITIATE_OPTIMIZE=1, spawn vitest run with fuzz test filter.
 * - **libfuzzer**: All existing CLI behavior (parent/child supervisor, shmem, libFuzzer flags).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { object, or } from "@optique/core/constructs";
import {
  option,
  argument,
  command,
  constant,
  passThrough,
} from "@optique/core/primitives";
import { integer, string } from "@optique/core/valueparser";
import { optional, multiple, withDefault } from "@optique/core/modifiers";
import { type InferValue, parseSync } from "@optique/core/parser";
import { formatMessage, lineBreak, text } from "@optique/core/message";
import { runSync, type RunOptions } from "@optique/run";
import escapeStringRegexp from "escape-string-regexp";
import { ShmemHandle } from "@vitiate/engine";
import { vitiatePlugin } from "./plugin.js";
import {
  MAX_RESPAWNS,
  runSupervisor,
  type SupervisorResult,
} from "./supervisor.js";
import {
  DEFAULT_MAX_INPUT_LEN,
  isSupervisorChild,
  getCliIpc,
  setCliIpc,
  warnUnknownVitiateEnvVars,
  getProjectRoot,
  getDataDir,
  resolveVitestCli,
  type FuzzOptions,
} from "./config.js";
import { KNOWN_DETECTOR_KEYS } from "./detectors/index.js";
import { hashTestPath } from "./nix-base32.js";
import {
  getTestDataDir,
  getCorpusDir,
  getTestPathStats,
  listOnDiskHashDirs,
  countOrphanEntries,
  type TestPathStats,
} from "./corpus.js";

/** Glob matching all fuzz test file extensions supported by vitest. */
const FUZZ_FILE_GLOB = "**/*.fuzz.{ts,tsx,js,jsx,mts,mjs,cts,cjs}";

/** Regex matching fuzz test file suffixes across all vitest-supported extensions. */
const FUZZ_FILE_SUFFIX_RE = /\.fuzz\.[cm]?[jt]sx?$/;

export interface CliArgs {
  testFile: string;
  corpusDirs: readonly string[];
  testName?: string;
  artifactPrefix?: string;
  dictPath?: string;
  merge: boolean;
  fuzzOptions: FuzzOptions;
  forkExplicit?: boolean;
  /** libFuzzer `-error_exitcode` override for the final crash exit code. */
  errorExitcode?: number;
  /** libFuzzer `-timeout_exitcode` override for the final timeout exit code. */
  timeoutExitcode?: number;
}

export const libfuzzerParser = object({
  testFile: argument(string({ metavar: "TEST_FILE" })),
  corpusDirs: withDefault(
    multiple(argument(string({ metavar: "CORPUS_DIR", pattern: /^[^-]/ }))),
    [],
  ),
  maxLen: optional(
    option("-max_len", integer({ min: 1 }), {
      description: [text("Maximum input length in bytes")],
    }),
  ),
  timeout: optional(
    option("-timeout", integer({ min: 0 }), {
      description: [text("Per-execution timeout in seconds (0 = disabled)")],
    }),
  ),
  runs: optional(
    option("-runs", integer({ min: 0 }), {
      description: [
        text(
          "Number of fuzzing iterations. 0 replays the corpus once and exits; " +
            "omit for unlimited",
        ),
      ],
    }),
  ),
  seed: optional(
    option("-seed", integer(), {
      description: [text("Random seed for reproducibility")],
    }),
  ),
  maxTotalTime: optional(
    option("-max_total_time", integer({ min: 0 }), {
      description: [text("Total fuzzing time limit in seconds")],
    }),
  ),
  testName: optional(
    option("-test", string(), {
      description: [text("Run only the named fuzz test")],
    }),
  ),
  minimizeBudget: optional(
    option("-minimize_budget", integer({ min: 0 }), {
      description: [text("Max iterations for input minimization")],
    }),
  ),
  minimizeTimeLimit: optional(
    option("-minimize_time_limit", integer({ min: 0 }), {
      description: [text("Time limit for input minimization in seconds")],
    }),
  ),
  artifactPrefix: optional(
    option("-artifact_prefix", string(), {
      description: [text("Path prefix for crash artifacts")],
    }),
  ),
  dict: optional(
    option("-dict", string(), {
      description: [text("Path to a fuzzing dictionary file")],
    }),
  ),
  detectors: optional(
    option("-detectors", string(), {
      description: [
        text(
          "Comma-separated list of bug detectors to enable. " +
            "When specified, all defaults are disabled and only listed " +
            "detectors are enabled. Pass an empty string to disable all.",
        ),
        lineBreak(),
        text(`Detectors: ${[...KNOWN_DETECTOR_KEYS].join(", ")}`),
        lineBreak(),
        text("Syntax: name to enable, name.key=value to set options."),
        lineBreak(),
        text(
          "pathTraversal accepts allowedPaths and deniedPaths options. " +
            "Use the platform path separator (: on POSIX, ; on Windows) " +
            "to specify multiple paths in a single value.",
        ),
        lineBreak(),
        text("Examples: -detectors prototypePollution,pathTraversal"),
        lineBreak(),
        text(
          "          -detectors pathTraversal.deniedPaths=/etc/passwd:/etc/shadow",
        ),
      ],
    }),
  ),
  // libFuzzer-compatible flags: accepted for fuzzing-platform compatibility
  fork: optional(
    option("-fork", integer({ min: 0 }), {
      description: [
        text(
          "Parallel fuzzing workers (libFuzzer compat, accepted but ignored)",
        ),
      ],
    }),
  ),
  jobs: optional(
    option("-jobs", integer({ min: 0 }), {
      description: [
        text(
          "Independent fuzzing sessions (libFuzzer compat, accepted but ignored)",
        ),
      ],
    }),
  ),
  merge: optional(
    option("-merge", integer({ min: 0 }), {
      description: [
        text("Corpus minimization via set cover (1 = enabled, 0 = disabled)"),
      ],
    }),
  ),
  // Additional libFuzzer flags accepted for fuzzing-platform compatibility, so
  // orchestrator invocations do not abort on an unknown flag. The exit-code
  // flags (-error_exitcode/-timeout_exitcode) are honored (see
  // supervisorExitCode); the rest are parsed but ignored (see warnUnsupportedFlags).
  rssLimitMb: optional(
    option("-rss_limit_mb", integer({ min: 0 }), {
      description: [
        text("Memory limit in MB (libFuzzer compat, accepted but ignored)"),
      ],
    }),
  ),
  timeoutExitcode: optional(
    option("-timeout_exitcode", integer(), {
      description: [
        text("Process exit code when a timeout is found (default 70)"),
      ],
    }),
  ),
  errorExitcode: optional(
    option("-error_exitcode", integer(), {
      description: [
        text("Process exit code when a crash is found (default 77)"),
      ],
    }),
  ),
  printFinalStats: optional(
    option("-print_final_stats", integer({ min: 0 }), {
      description: [
        text("Print final statistics (libFuzzer compat, accepted but ignored)"),
      ],
    }),
  ),
  closeFdMask: optional(
    option("-close_fd_mask", integer({ min: 0 }), {
      description: [
        text(
          "Close stdout/stderr during execution (libFuzzer compat, accepted but ignored)",
        ),
      ],
    }),
  ),
  reload: optional(
    option("-reload", integer({ min: 0 }), {
      description: [
        text(
          "Corpus reload interval in seconds (libFuzzer compat, accepted but ignored)",
        ),
      ],
    }),
  ),
});

const detectorsDescription = [
  text(
    "Comma-separated list of bug detectors to enable. " +
      "When specified, all defaults are disabled and only listed " +
      "detectors are enabled. Pass an empty string to disable all.",
  ),
  lineBreak(),
  text(`Detectors: ${[...KNOWN_DETECTOR_KEYS].join(", ")}`),
  lineBreak(),
  text("Syntax: name to enable, name.key=value to set options."),
  lineBreak(),
  text("Examples: --detectors prototypePollution,pathTraversal"),
];

const vitestForwardingDescription = [
  text("Unrecognized flags are forwarded to vitest."),
];

export const fuzzParser = object({
  subcommand: constant("fuzz" as const),
  fuzzTime: optional(
    option("--fuzz-time", integer({ min: 1 }), {
      description: [text("Total fuzzing time limit in seconds")],
    }),
  ),
  fuzzExecs: optional(
    option("--fuzz-execs", integer({ min: 1 }), {
      description: [text("Total number of fuzzing iterations")],
    }),
  ),
  maxCrashes: optional(
    option("--max-crashes", integer({ min: 1 }), {
      description: [text("Maximum crashes to collect")],
    }),
  ),
  detectors: optional(
    option("--detectors", string(), {
      description: detectorsDescription,
    }),
  ),
  positionalArgs: withDefault(
    multiple(argument(string({ metavar: "VITEST_ARG" }))),
    [],
  ),
  vitestArgs: passThrough({
    format: "nextToken",
    description: vitestForwardingDescription,
  }),
});

export const regressionParser = object({
  subcommand: constant("regression" as const),
  detectors: optional(
    option("--detectors", string(), {
      description: detectorsDescription,
    }),
  ),
  positionalArgs: withDefault(
    multiple(argument(string({ metavar: "VITEST_ARG" }))),
    [],
  ),
  vitestArgs: passThrough({
    format: "nextToken",
    description: vitestForwardingDescription,
  }),
});

export const optimizeParser = object({
  subcommand: constant("optimize" as const),
  detectors: optional(
    option("--detectors", string(), {
      description: detectorsDescription,
    }),
  ),
  timeout: optional(
    option("--timeout", integer({ min: 0 }), {
      description: [text("Per-entry replay timeout in seconds (0 = disabled)")],
    }),
  ),
  positionalArgs: withDefault(
    multiple(argument(string({ metavar: "VITEST_ARG" }))),
    [],
  ),
  vitestArgs: passThrough({
    format: "nextToken",
    description: vitestForwardingDescription,
  }),
});

export const reproduceParser = object({
  subcommand: constant("reproduce" as const),
  inputFile: argument(string({ metavar: "FILE" })),
  // Single-dash spellings match the libfuzzer subcommand for parity.
  testName: optional(
    option("-test", string(), {
      description: [text("Run only the named fuzz test")],
    }),
  ),
  timeout: optional(
    option("-timeout", integer({ min: 0 }), {
      description: [text("Per-execution timeout in seconds (0 = disabled)")],
    }),
  ),
});

const initParser = object({
  subcommand: constant("init" as const),
});

export const pathsParser = object({
  subcommand: constant("paths" as const),
  pattern: optional(
    argument(string({ metavar: "PATTERN" }), {
      description: [
        text("Filter tests by substring match on file, test name, or hash dir"),
      ],
    }),
  ),
  json: option("--json", {
    description: [text("Emit machine-readable JSON instead of a table")],
  }),
  absolute: option("--absolute", {
    description: [text("Print absolute directory paths")],
  }),
  dir: option("--dir", {
    description: [
      text(
        "Print only the matched test's testdata dir (requires a unique match)",
      ),
    ],
  }),
  orphans: option("--orphans", {
    description: [
      text("Also list on-disk dirs with no matching test (safe preview)"),
    ],
  }),
  prune: option("--prune", {
    description: [
      text("Delete orphaned corpus dirs (prompts before deleting)"),
    ],
  }),
  all: option("--all", {
    description: [text("With --prune, also delete orphaned testdata dirs")],
  }),
  force: option("--force", "-f", {
    description: [text("With --prune, skip the confirmation prompt")],
  }),
});

const cli = or(
  command("fuzz", fuzzParser, {
    brief: [text("Run fuzz tests")],
    description: [
      text(
        "Runs fuzz tests via vitest. Unrecognized flags are forwarded to vitest.",
      ),
    ],
  }),
  command("regression", regressionParser, {
    brief: [text("Run regression tests against saved corpus")],
    description: [
      text(
        "Runs regression tests via vitest. Unrecognized flags are forwarded to vitest.",
      ),
    ],
  }),
  command("reproduce", reproduceParser, {
    brief: [text("Replay a single input file through a fuzz target")],
    description: [
      text(
        "Runs one input byte-file once through the fuzz target; prints the " +
          "stack trace and exits non-zero on crash, zero on a clean run.",
      ),
    ],
  }),
  command("optimize", optimizeParser, {
    brief: [text("Minimize cached corpus via set cover")],
    description: [
      text(
        "Minimizes corpus via vitest. Unrecognized flags are forwarded to vitest.",
      ),
    ],
  }),
  command(
    "libfuzzer",
    object({
      subcommand: constant("libfuzzer" as const),
      rest: passThrough({ format: "greedy" }),
    }),
    {
      brief: [text("Run in libFuzzer-compatible mode")],
    },
  ),
  command("init", initParser, {
    brief: [text("Discover fuzz tests and create seed directories")],
  }),
  command("paths", pathsParser, {
    brief: [text("Show the test-to-directory mapping and corpus counts")],
    description: [
      text(
        "Read-only inspector: maps each fuzz test to its testdata/corpus " +
          "directory with per-bucket entry counts. Filter with PATTERN, detect " +
          "orphaned dirs with --orphans, and prune them with --prune.",
      ),
    ],
  }),
);

function warnUnsupportedFlags(
  parsed: InferValue<typeof libfuzzerParser>,
): void {
  // The supervisor spawns a child that re-parses the same args; warn only in
  // the parent so each advisory is printed once (mirrors warnUnknownVitiateEnvVars).
  if (isSupervisorChild()) return;
  if (parsed.fork !== undefined && parsed.fork !== 1) {
    if (parsed.fork === 0) {
      process.stderr.write(
        `vitiate: warning: -fork=0 (in-process mode) is not supported; vitiate always runs the fuzz target in a supervised child process\n`,
      );
    } else {
      process.stderr.write(
        `vitiate: warning: -fork=${parsed.fork} is ignored; vitiate does not support parallel workers and always runs a single supervised child process\n`,
      );
    }
  }
  if (parsed.jobs !== undefined && parsed.jobs !== 1) {
    process.stderr.write(
      `vitiate: warning: -jobs=${parsed.jobs} is ignored; vitiate collects crashes continuously in a single process instead of running independent per-crash sessions. Use VITIATE_MAX_CRASHES to limit crash collection.\n`,
    );
  }
  // Note: -error_exitcode / -timeout_exitcode are honored (see supervisorExitCode),
  // so they are not warned about here.
  if (parsed.closeFdMask !== undefined && parsed.closeFdMask !== 0) {
    process.stderr.write(
      `vitiate: warning: -close_fd_mask=${parsed.closeFdMask} is ignored; vitiate does not suppress target stdout/stderr during execution\n`,
    );
  }
}

/**
 * Parse the `-detectors` flag value into a `FuzzOptions.detectors` config object.
 *
 * When `-detectors` is specified, ALL defaults are disabled. Only explicitly
 * listed detectors are enabled. This avoids the need for a `none` sentinel
 * and makes the flag self-contained: you get exactly what you list.
 *
 * Syntax: comma-separated directives:
 * - `name` -> enable
 * - `name.key=value` -> enable with option
 */
export function parseDetectorsFlag(spec: string): FuzzOptions["detectors"] {
  // Start with all detectors disabled - the flag overrides all defaults.
  const detectors: Record<string, unknown> = {};
  for (const name of KNOWN_DETECTOR_KEYS) {
    detectors[name] = false;
  }

  const directives = spec
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  for (const directive of directives) {
    // Option: name.key=value
    const dotIdx = directive.indexOf(".");
    if (dotIdx !== -1) {
      const name = directive.slice(0, dotIdx);
      if (!KNOWN_DETECTOR_KEYS.has(name)) {
        process.stderr.write(
          `vitiate: error: unknown detector: ${name}\nValid detectors: ${[...KNOWN_DETECTOR_KEYS].join(", ")}\n`,
        );
        process.exit(1);
      }
      const rest = directive.slice(dotIdx + 1);
      const eqIdx = rest.indexOf("=");
      if (eqIdx === -1) {
        process.stderr.write(
          `vitiate: error: invalid detector option syntax: ${directive} (expected name.key=value)\n`,
        );
        process.exit(1);
      }
      const key = rest.slice(0, eqIdx);
      const rawValue = rest.slice(eqIdx + 1);
      const value: string | number = /^-?\d+(\.\d+)?$/.test(rawValue)
        ? Number(rawValue)
        : rawValue;
      const existing = detectors[name];
      if (typeof existing === "object" && existing !== null) {
        (existing as Record<string, string | number>)[key] = value;
      } else {
        detectors[name] = { [key]: value };
      }
      continue;
    }

    // Enable: name
    if (!KNOWN_DETECTOR_KEYS.has(directive)) {
      process.stderr.write(
        `vitiate: error: unknown detector: ${directive}\nValid detectors: ${[...KNOWN_DETECTOR_KEYS].join(", ")}\n`,
      );
      process.exit(1);
    }
    // Only set to true if not already an options object
    if (
      !(
        typeof detectors[directive] === "object" &&
        detectors[directive] !== null
      )
    ) {
      detectors[directive] = true;
    }
  }

  return detectors as FuzzOptions["detectors"];
}

function toCliArgs(parsed: InferValue<typeof libfuzzerParser>): CliArgs {
  warnUnsupportedFlags(parsed);
  const {
    testFile,
    corpusDirs,
    testName,
    artifactPrefix,
    maxLen,
    timeout,
    runs,
    seed,
    maxTotalTime,
    minimizeBudget,
    minimizeTimeLimit,
    dict,
  } = parsed;

  // Validate and resolve -dict path
  let dictPath: string | undefined;
  if (dict !== undefined) {
    const resolved = path.resolve(dict);
    if (!existsSync(resolved)) {
      process.stderr.write(
        `vitiate: error: dictionary file not found: ${dict}\n`,
      );
      process.exit(1);
    }
    dictPath = resolved;
  }

  // Parse -detectors flag
  const detectors =
    parsed.detectors !== undefined
      ? parseDetectorsFlag(parsed.detectors)
      : undefined;

  return {
    testFile,
    corpusDirs,
    testName,
    artifactPrefix,
    dictPath,
    merge: parsed.merge !== undefined && parsed.merge !== 0,
    forkExplicit: parsed.fork !== undefined ? true : undefined,
    // libFuzzer exit-code overrides, honored by the parent supervisor.
    errorExitcode: parsed.errorExitcode,
    timeoutExitcode: parsed.timeoutExitcode,
    // CLI flags use seconds (matching libFuzzer convention).
    // Internal FuzzOptions use milliseconds. All conversions happen here.
    fuzzOptions: {
      maxLen,
      timeoutMs: timeout != null ? timeout * 1000 : undefined,
      // libFuzzer semantics: an explicit `-runs=0` means "replay the corpus
      // once and exit" (not unlimited). A positive value caps main-loop
      // iterations; omitting the flag leaves fuzzExecs unset (unlimited).
      fuzzExecs: runs === 0 ? undefined : runs,
      replayOnly: runs === 0 ? true : undefined,
      seed,
      fuzzTimeMs: maxTotalTime != null ? maxTotalTime * 1000 : undefined,
      minimizeBudget,
      minimizeTimeLimitMs:
        minimizeTimeLimit != null ? minimizeTimeLimit * 1000 : undefined,
      detectors,
    },
  };
}

export function parseArgs(argv: string[]): CliArgs {
  const result = parseSync(libfuzzerParser, argv.slice(2));
  if (!result.success) {
    throw new Error(formatMessage(result.error));
  }
  return toCliArgs(result.value);
}

/**
 * Parent supervisor: allocates shmem, spawns the child, enters the
 * shared supervisor wait/respawn loop.
 */
async function runParentMode(
  testFile: string,
  maxInputLen: number,
  testName?: string,
  artifactPrefix?: string,
  exitCodeOverrides?: { errorExitcode?: number; timeoutExitcode?: number },
): Promise<void> {
  const shmem = ShmemHandle.allocate(maxInputLen);
  const relativeTestFilePath = path.relative(
    getProjectRoot(),
    path.resolve(testFile),
  );

  // When -test is provided, use it as the test name for artifact paths.
  // Otherwise, fall back to deriving from the filename (correct for the
  // single-test-per-file convention used by libFuzzer-based platforms).
  const resolvedTestName =
    testName ?? path.basename(testFile, path.extname(testFile));

  // Resolve artifact prefix: flag value or CLI default (./)
  const resolvedArtifactPrefix = artifactPrefix ?? "./";

  const result = await runSupervisor({
    shmem,
    relativeTestFilePath,
    testName: resolvedTestName,
    artifactPrefix: resolvedArtifactPrefix,
    spawnChild: () =>
      spawn(process.execPath, process.argv.slice(1), {
        env: { ...process.env, VITIATE_SUPERVISOR: "1" },
        stdio: ["ignore", "inherit", "inherit"],
      }),
  });

  process.exitCode = supervisorExitCode(result, exitCodeOverrides);
}

/**
 * Default process exit code when a crash is found. Matches libFuzzer's
 * `error_exitcode` default so vitiate is drop-in compatible with fuzzing
 * platforms out of the box; overridable via `-error_exitcode`.
 */
export const DEFAULT_ERROR_EXITCODE = 77;

/**
 * Default process exit code when the finding is a timeout. Matches libFuzzer's
 * `timeout_exitcode` default; overridable via `-timeout_exitcode`.
 */
export const DEFAULT_TIMEOUT_EXITCODE = 70;

/**
 * Default per-execution replay timeout (seconds) for the `reproduce`
 * subcommand when `-timeout` is omitted, matching libFuzzer's `-timeout`
 * default. Without it the single-input replay runs with no vitiate watchdog
 * and a hung input is bounded only by vitest's `testTimeout` (which cannot
 * interrupt a synchronous loop). Defaulting arms the watchdog so any hang is
 * bounded by its `_exit` fallback and attributed with a `timeout-*` artifact.
 * Pass `-timeout 0` to disable the watchdog.
 */
export const DEFAULT_REPRODUCE_TIMEOUT_SECONDS = 1200;

/**
 * Resolve the `reproduce` replay timeout (milliseconds) from the parsed
 * `-timeout` flag (seconds). Omitted arms the watchdog at libFuzzer's default;
 * an explicit value wins; `0` stays `0` and disables the watchdog.
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
 * Map a {@link SupervisorResult} to a process exit code for CLI parent modes,
 * following libFuzzer's exit-code conventions.
 *
 * Distinguishes a crash, a timeout, and infrastructure failures so orchestrators
 * and CI do not mistake an OOM/eviction or a startup failure for a confirmed
 * finding:
 * - timeout -> `timeout_exitcode` (default 70)
 * - crash -> `error_exitcode` (default 77)
 * - SIGKILL / OOM -> 137 (external infra kill, even when reported as a signal)
 * - startup failure / engine panic -> the child's own non-zero exit code
 * - otherwise -> the child's exit code (0 on clean completion)
 *
 * :param overrides: exit codes from `-error_exitcode`/`-timeout_exitcode`.
 */
export function supervisorExitCode(
  result: SupervisorResult,
  overrides: { errorExitcode?: number; timeoutExitcode?: number } = {},
): number {
  const errorCode = overrides.errorExitcode ?? DEFAULT_ERROR_EXITCODE;
  const timeoutCode = overrides.timeoutExitcode ?? DEFAULT_TIMEOUT_EXITCODE;
  // A timeout sets both `timedOut` and `crashed`, so check it first.
  if (result.timedOut) return timeoutCode;
  if (result.crashed) return errorCode;
  if (result.oomKilled) return 137;
  if (result.startupFailure || result.engineError) return result.exitCode ?? 1;
  return result.exitCode ?? 0;
}

/**
 * Parent supervisor for merge mode: allocates shmem, creates control file,
 * spawns child with merge env vars, cleans up after.
 */
async function runMergeParentMode(
  testFile: string,
  corpusDirs: readonly string[],
  maxInputLen: number,
  testName?: string,
  exitCodeOverrides?: { errorExitcode?: number; timeoutExitcode?: number },
): Promise<void> {
  if (corpusDirs.length === 0) {
    process.stderr.write(
      "vitiate: error: -merge=1 requires at least one corpus directory\n",
    );
    process.exitCode = 1;
    return;
  }

  const shmem = ShmemHandle.allocate(maxInputLen);
  const controlFilePath = path.join(
    tmpdir(),
    `vitiate-merge-${randomUUID()}.jsonl`,
  );

  const result = await runSupervisor({
    shmem,
    relativeTestFilePath: path.relative(
      getProjectRoot(),
      path.resolve(testFile),
    ),
    testName: testName ?? path.basename(testFile, path.extname(testFile)),
    spawnChild: () =>
      spawn(process.execPath, process.argv.slice(1), {
        env: {
          ...process.env,
          VITIATE_SUPERVISOR: "1",
          VITIATE_CLI_IPC: JSON.stringify({
            merge: true,
            mergeControlFile: controlFilePath,
          }),
        },
        stdio: ["ignore", "inherit", "inherit"],
      }),
    maxRespawns: MAX_RESPAWNS,
  });

  // Clean up control file
  try {
    unlinkSync(controlFilePath);
  } catch {
    // Ignore - may not exist if merge had no entries
  }

  process.exitCode = supervisorExitCode(result, exitCodeOverrides);
}

/**
 * Child mode for merge: starts Vitest with instrumentation for merge replay.
 */
async function runMergeChildMode(
  testFile: string,
  corpusDirs: readonly string[],
  fuzzOptions: FuzzOptions,
  testName?: string,
): Promise<void> {
  // Forward CLI options (including detectors) to fuzz targets via env var
  process.env["VITIATE_OPTIONS"] = JSON.stringify(fuzzOptions);

  // Merge into existing IPC blob (parent already set merge+mergeControlFile)
  if (corpusDirs.length > 0) {
    const existing = getCliIpc();
    setCliIpc({ ...existing, corpusDirs: [...corpusDirs] });
  }

  const { startVitest } = await import("vitest/node");

  const vitest = await startVitest(
    "test",
    [testFile],
    {
      include: [testFile],
      testTimeout: 0,
      ...(testName
        ? { testNamePattern: `^${escapeStringRegexp(testName)}$` }
        : {}),
    },
    {
      plugins: [vitiatePlugin({ instrument: {} })],
    },
  );

  if (vitest) {
    await vitest.close();
  } else {
    process.stderr.write("vitiate: vitest failed to start\n");
    process.exitCode = 1;
  }
}

/**
 * Child mode: starts Vitest in fuzzing mode (existing behavior).
 */
async function runChildMode(
  testFile: string,
  corpusDirs: readonly string[],
  fuzzOptions: FuzzOptions,
  testName?: string,
  artifactPrefix?: string,
  dictPath?: string,
  forkExplicit?: boolean,
): Promise<void> {
  // Activate fuzzing mode
  process.env["VITIATE_FUZZ"] = "1";

  // Forward CLI options to fuzz targets via env var
  process.env["VITIATE_OPTIONS"] = JSON.stringify(fuzzOptions);

  // Forward CLI IPC state to fuzz targets via single JSON blob
  setCliIpc({
    libfuzzerCompat: true,
    corpusDirs: corpusDirs.length > 0 ? [...corpusDirs] : undefined,
    corpusOutputDir: corpusDirs.length > 0 ? corpusDirs[0] : undefined,
    artifactPrefix,
    dictionaryPath: dictPath,
    forkExplicit,
  });

  const { startVitest } = await import("vitest/node");

  const vitest = await startVitest(
    "test",
    [testFile],
    {
      include: [testFile],
      testTimeout: 0,
      ...(testName
        ? { testNamePattern: `^${escapeStringRegexp(testName)}$` }
        : {}),
    },
    {
      plugins: [vitiatePlugin({ instrument: {} })],
    },
  );

  if (vitest) {
    await vitest.close();
  } else {
    process.stderr.write("vitiate: vitest failed to start\n");
    process.exitCode = 1;
  }
}

/**
 * libfuzzer subcommand handler: all existing CLI behavior.
 */
async function runLibfuzzerSubcommand(args: readonly string[]): Promise<void> {
  const {
    testFile,
    corpusDirs,
    testName,
    artifactPrefix,
    dictPath,
    merge,
    fuzzOptions,
    forkExplicit,
    errorExitcode,
    timeoutExitcode,
  } = toCliArgs(
    runSync(libfuzzerParser, {
      programName: "vitiate libfuzzer",
      args,
      brief: [text("Coverage-guided JavaScript fuzzer (libFuzzer-compatible)")],
      description: [
        text(
          "Instruments JS/TS source with edge coverage counters via SWC and " +
            "drives mutation-based fuzzing via LibAFL. Accepts libFuzzer-compatible " +
            "flags. Configuration via per-test options, VITIATE_OPTIONS JSON " +
            "env var, or CLI flags.",
        ),
      ],
      help: {
        option: { names: ["-help", "--help"] },
      },
    } satisfies RunOptions),
  );

  if (!isSupervisorChild()) {
    warnUnknownVitiateEnvVars();
  }

  if (merge) {
    // Merge mode: corpus minimization via set cover
    if (isSupervisorChild()) {
      await runMergeChildMode(testFile, corpusDirs, fuzzOptions, testName);
    } else {
      const maxInputLen = fuzzOptions.maxLen ?? DEFAULT_MAX_INPUT_LEN;
      await runMergeParentMode(testFile, corpusDirs, maxInputLen, testName, {
        errorExitcode,
        timeoutExitcode,
      });
    }
  } else if (isSupervisorChild()) {
    // Child mode: shmem is already set up by the parent
    await runChildMode(
      testFile,
      corpusDirs,
      fuzzOptions,
      testName,
      artifactPrefix,
      dictPath,
      forkExplicit,
    );
  } else {
    // Parent mode: allocate shmem, spawn child, supervise
    const maxInputLen = fuzzOptions.maxLen ?? DEFAULT_MAX_INPUT_LEN;
    await runParentMode(testFile, maxInputLen, testName, artifactPrefix, {
      errorExitcode,
      timeoutExitcode,
    });
  }
}

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
    process.stderr.write(
      "vitiate: error: vitest is required but not installed. Run `npm install -D vitest` first.\n",
    );
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
 * Discover all `fuzz()` tests in the project by globbing `*.fuzz.*` files and
 * collecting their fully-qualified test names via vitest.
 *
 * :returns: the list of discovered `{ file, name }` pairs (`file` relative to
 *   the project root), or `null` if vitest is not installed (an error is
 *   printed to stderr in that case). An empty array means no fuzz tests found.
 */
async function discoverFuzzTests(): Promise<
  { file: string; name: string }[] | null
> {
  let createVitest: (typeof import("vitest/node"))["createVitest"];
  try {
    ({ createVitest } = await import("vitest/node"));
  } catch {
    process.stderr.write(
      "vitiate: error: vitest is required but not installed. Run `npm install -D vitest` first.\n",
    );
    return null;
  }

  const vitest = await createVitest(
    "test",
    {
      include: [FUZZ_FILE_GLOB],
    },
    {
      plugins: [vitiatePlugin({ instrument: {} })],
    },
  );

  try {
    const specs = await vitest.globTestSpecifications();
    if (specs.length === 0) return [];

    // Collect test specifications to discover test names
    await vitest.collectTests(specs);

    const projectRoot = getProjectRoot();
    const tests: { file: string; name: string }[] = [];
    for (const module of vitest.state.getTestModules()) {
      const filePath = module.moduleId;
      if (!FUZZ_FILE_SUFFIX_RE.test(filePath)) continue;
      const relativeFile = path.relative(projectRoot, filePath);
      for (const testCase of module.children.allTests()) {
        tests.push({ file: relativeFile, name: testCase.fullName });
      }
    }
    return tests;
  } finally {
    await vitest.close();
  }
}

/** One fuzz test mapped to its on-disk directories and corpus counts. */
export interface TestManifestRow {
  file: string;
  name: string;
  hashDir: string;
  testDataDir: string;
  corpusDir: string;
  stats: TestPathStats;
}

/**
 * Map discovered `{ file, name }` pairs to their hash dir, testdata/corpus
 * directories, and per-bucket counts. Pure and read-only (creates nothing);
 * shared by the `init` and `paths` subcommands.
 */
function buildTestManifest(
  discovered: { file: string; name: string }[],
): TestManifestRow[] {
  return discovered.map(({ file, name }) => ({
    file,
    name,
    hashDir: hashTestPath(file, name),
    testDataDir: getTestDataDir(file, name),
    corpusDir: getCorpusDir(file, name),
    stats: getTestPathStats(file, name),
  }));
}

/**
 * init subcommand: discover fuzz tests, create seed directories, manage .gitignore.
 */
async function runInitSubcommand(): Promise<void> {
  const discovered = await discoverFuzzTests();
  if (discovered === null) {
    process.exitCode = 1;
    return;
  }
  if (discovered.length === 0) {
    process.stdout.write("No fuzz tests (*.fuzz.*) found.\n");
    return;
  }

  const projectRoot = getProjectRoot();
  const tests = buildTestManifest(discovered);
  for (const t of tests) {
    mkdirSync(path.join(t.testDataDir, "seeds"), { recursive: true });
  }

  // Manage .gitignore
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const gitignoreEntry = ".vitiate/corpus/";
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.split("\n").some((line) => line.trim() === gitignoreEntry)) {
      appendFileSync(gitignorePath, `\n${gitignoreEntry}\n`);
    }
  } else {
    writeFileSync(gitignorePath, `${gitignoreEntry}\n`);
  }

  // Print manifest
  process.stdout.write("\nDiscovered fuzz tests:\n\n");
  const fileWidth = Math.max(4, ...tests.map((t) => t.file.length));
  const nameWidth = Math.max(4, ...tests.map((t) => t.name.length));
  process.stdout.write(
    `${"File".padEnd(fileWidth)}  ${"Test".padEnd(nameWidth)}  Hash Directory\n`,
  );
  process.stdout.write(
    `${"-".repeat(fileWidth)}  ${"-".repeat(nameWidth)}  ${"-".repeat(32)}\n`,
  );
  for (const t of tests) {
    process.stdout.write(
      `${t.file.padEnd(fileWidth)}  ${t.name.padEnd(nameWidth)}  ${t.hashDir}\n`,
    );
  }
  process.stdout.write(
    `\n${tests.length} test(s) found. Seed directories created.\n`,
  );
}

/** An on-disk hash dir with no matching discovered test. */
export interface OrphanDir {
  kind: "testdata" | "corpus";
  hashDir: string;
  /** Absolute path to the orphaned directory. */
  path: string;
  /** Entry count, for reporting (see {@link countOrphanEntries}). */
  entries: number;
}

/**
 * Find on-disk `testdata/`+`corpus/` hash dirs that match no discovered test.
 * These are leftovers from renamed or deleted tests.
 */
export function findOrphans(manifest: TestManifestRow[]): OrphanDir[] {
  const known = new Set(manifest.map((r) => r.hashDir));
  const orphans: OrphanDir[] = [];
  for (const kind of ["testdata", "corpus"] as const) {
    for (const hashDir of listOnDiskHashDirs(kind)) {
      if (known.has(hashDir)) continue;
      orphans.push({
        kind,
        hashDir,
        path: path.join(getDataDir(), kind, hashDir),
        entries: countOrphanEntries(kind, hashDir),
      });
    }
  }
  return orphans;
}

/**
 * Select which orphans a prune should delete: corpus orphans always, testdata
 * orphans only when `all` is set (they may hold committed crashes/seeds).
 */
export function selectPruneTargets(
  orphans: OrphanDir[],
  all: boolean,
): OrphanDir[] {
  return orphans.filter((o) => o.kind === "corpus" || all);
}

/** Delete the given orphan directories. Pure side effect (no prompting). */
export function deleteOrphans(targets: OrphanDir[]): void {
  for (const t of targets) {
    rmSync(t.path, { recursive: true, force: true });
  }
}

/**
 * Prompt for a yes/no answer; resolves true only on y/yes. Streams are
 * injectable for testing and default to the process stdio.
 */
export function promptYesNo(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    rl.question(question, (answer) => {
      // Resolve before close(): rl.close() emits "close", and resolving first
      // makes the close-handler's resolve(false) a no-op for an answered prompt.
      resolve(/^y(es)?$/i.test(answer.trim()));
      rl.close();
    });
    // EOF (Ctrl-D) or a closed stdin fires "close" without an answer: treat as
    // a declined prompt rather than leaving the promise pending forever.
    rl.on("close", () => resolve(false));
  });
}

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

/**
 * Validate the paths flag combination. Returns an error message (without the
 * `vitiate: error:` prefix) or `null` if the flags are consistent.
 *
 * `--all`/`--force` are only meaningful with `--prune`, and `--dir`/`--json`/
 * `--prune` are mutually-exclusive output/action modes.
 */
export function validatePathsFlags(
  parsed: InferValue<typeof pathsParser>,
): string | null {
  if (parsed.all && !parsed.prune) {
    return "--all is only valid with --prune.";
  }
  if (parsed.force && !parsed.prune) {
    return "--force is only valid with --prune.";
  }
  const modes = [parsed.dir, parsed.json, parsed.prune].filter(Boolean).length;
  if (modes > 1) {
    return "--dir, --json, and --prune are mutually exclusive.";
  }
  return null;
}

/**
 * Decide orphan handling for a paths invocation. An empty manifest means the
 * test set is unknown (no fuzz tests discovered), so every on-disk directory
 * would look orphaned; orphan scanning and pruning are refused in that case to
 * avoid deleting live data. Orphans are only scanned when an orphan-consuming
 * flag (`--orphans`/`--prune`/`--json`) is set and the manifest is non-empty.
 */
export function resolveOrphans(
  manifest: TestManifestRow[],
  parsed: InferValue<typeof pathsParser>,
): { refuse: boolean; orphans: OrphanDir[] } {
  if (manifest.length === 0) {
    if (parsed.orphans || parsed.prune) {
      return { refuse: true, orphans: [] };
    }
    return { refuse: false, orphans: [] };
  }
  const wantOrphans = parsed.orphans || parsed.prune || parsed.json;
  return { refuse: false, orphans: wantOrphans ? findOrphans(manifest) : [] };
}

/** Message for an empty paths table: distinguishes no-tests from no-match. */
export function pathsEmptyMessage(pattern?: string): string {
  return pattern === undefined
    ? "No fuzz tests (*.fuzz.*) found."
    : `No fuzz tests match ${JSON.stringify(pattern)}.`;
}

/**
 * paths subcommand: read-only inspector mapping each fuzz test to its
 * testdata/corpus directory with per-bucket counts, with pattern filtering,
 * orphan detection, and (opt-in) pruning.
 */
async function runPathsSubcommand(
  parsed: InferValue<typeof pathsParser>,
): Promise<void> {
  const flagError = validatePathsFlags(parsed);
  if (flagError !== null) {
    process.stderr.write(`vitiate: error: ${flagError}\n`);
    process.exitCode = 1;
    return;
  }

  // Safety gate: without a known test set, every dir looks orphaned. Never
  // scan/prune on an unknown set. discoverFuzzTests prints its own error.
  const discovered = await discoverFuzzTests();
  if (discovered === null) {
    process.exitCode = 1;
    return;
  }

  const manifest = buildTestManifest(discovered);

  // Filter by pattern: case-insensitive substring over file, name, or hashDir.
  const pattern = parsed.pattern?.toLowerCase();
  const filtered =
    pattern === undefined
      ? manifest
      : manifest.filter(
          (r) =>
            r.file.toLowerCase().includes(pattern) ||
            r.name.toLowerCase().includes(pattern) ||
            r.hashDir.toLowerCase().includes(pattern),
        );

  // --dir: print only the unique match's testdata dir (for scripting/seeding).
  if (parsed.dir) {
    if (filtered.length !== 1) {
      const which =
        manifest.length === 0
          ? "no fuzz tests were discovered"
          : parsed.pattern === undefined
            ? "a PATTERN matching exactly one test"
            : `${filtered.length} tests match ${JSON.stringify(parsed.pattern)}`;
      process.stderr.write(
        `vitiate: error: --dir requires exactly one match (${which}).\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${filtered[0]!.testDataDir}\n`);
    return;
  }

  const { refuse, orphans } = resolveOrphans(manifest, parsed);
  if (refuse) {
    process.stderr.write(
      "vitiate: error: no fuzz tests discovered; refusing --orphans/--prune " +
        "(every directory would appear orphaned). Check you are in the right " +
        "project directory.\n",
    );
    process.exitCode = 1;
    return;
  }

  if (parsed.prune) {
    await prunePaths(orphans, parsed.all, parsed.force);
    return;
  }

  if (parsed.json) {
    renderPathsJson(filtered, orphans);
    return;
  }

  renderPathsTable(filtered, parsed.absolute, parsed.pattern);
  if (parsed.orphans) {
    renderOrphansSection(orphans, parsed.absolute);
  }
}

/**
 * Delete orphaned dirs, confirming first unless `force`. The `confirm` seam
 * defaults to an interactive stdin prompt but is injectable for tests.
 */
export async function prunePaths(
  orphans: OrphanDir[],
  all: boolean,
  force: boolean,
  confirm: (question: string) => Promise<boolean> = promptYesNo,
): Promise<void> {
  const targets = selectPruneTargets(orphans, all);
  if (targets.length === 0) {
    process.stdout.write("No orphaned directories to prune.\n");
    return;
  }

  process.stdout.write(
    `The following ${targets.length} orphaned ${plural(
      targets.length,
      "directory",
      "directories",
    )} will be deleted:\n`,
  );
  for (const t of targets) {
    process.stdout.write(
      `  ${t.kind}/${t.hashDir}  (${t.entries} ${plural(
        t.entries,
        "entry",
        "entries",
      )})\n`,
    );
  }
  const skipped = orphans.length - targets.length;
  if (skipped > 0) {
    process.stdout.write(
      `(${skipped} orphaned testdata ${plural(
        skipped,
        "dir",
        "dirs",
      )} left intact; pass --all to prune those too.)\n`,
    );
  }

  if (!force) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "vitiate: error: refusing to delete without confirmation; re-run with --force to prune non-interactively.\n",
      );
      process.exitCode = 1;
      return;
    }
    const confirmed = await confirm(
      `Delete ${targets.length} ${plural(
        targets.length,
        "directory",
        "directories",
      )}? [y/N] `,
    );
    if (!confirmed) {
      process.stdout.write("Aborted.\n");
      return;
    }
  }

  // Delete and report per target, so a mid-loop failure still shows exactly
  // what was removed instead of a bare Fatal with no audit trail.
  for (const t of targets) {
    deleteOrphans([t]);
    process.stdout.write(`Removed ${t.path}\n`);
  }
  process.stdout.write(
    `Pruned ${targets.length} ${plural(
      targets.length,
      "directory",
      "directories",
    )}.\n`,
  );
}

/** Render the test -> directory table with per-bucket counts. */
function renderPathsTable(
  rows: TestManifestRow[],
  absolute: boolean,
  pattern?: string,
): void {
  if (rows.length === 0) {
    process.stdout.write(`${pathsEmptyMessage(pattern)}\n`);
    return;
  }
  const projectRoot = getProjectRoot();
  const display = rows.map((r) => ({
    file: r.file,
    name: r.name,
    seeds: String(r.stats.seeds),
    crashes: String(r.stats.crashes),
    timeouts: String(r.stats.timeouts),
    dir: absolute ? r.testDataDir : path.relative(projectRoot, r.testDataDir),
  }));
  const fileW = Math.max(4, ...display.map((r) => r.file.length));
  const nameW = Math.max(4, ...display.map((r) => r.name.length));
  const seedsW = Math.max(5, ...display.map((r) => r.seeds.length));
  const crashW = Math.max(7, ...display.map((r) => r.crashes.length));
  const toW = Math.max(8, ...display.map((r) => r.timeouts.length));
  process.stdout.write(
    `${"File".padEnd(fileW)}  ${"Test".padEnd(nameW)}  ${"seeds".padStart(
      seedsW,
    )}  ${"crashes".padStart(crashW)}  ${"timeouts".padStart(
      toW,
    )}  Directory\n`,
  );
  process.stdout.write(
    `${"-".repeat(fileW)}  ${"-".repeat(nameW)}  ${"-".repeat(
      seedsW,
    )}  ${"-".repeat(crashW)}  ${"-".repeat(toW)}  ${"-".repeat(9)}\n`,
  );
  for (const r of display) {
    process.stdout.write(
      `${r.file.padEnd(fileW)}  ${r.name.padEnd(nameW)}  ${r.seeds.padStart(
        seedsW,
      )}  ${r.crashes.padStart(crashW)}  ${r.timeouts.padStart(toW)}  ${
        r.dir
      }\n`,
    );
  }
  process.stdout.write(
    `\n${rows.length} ${plural(rows.length, "test", "tests")}.\n`,
  );
}

/** Print the orphaned-directory section beneath the table. */
function renderOrphansSection(orphans: OrphanDir[], absolute: boolean): void {
  process.stdout.write("\n");
  if (orphans.length === 0) {
    process.stdout.write("No orphaned directories.\n");
    return;
  }
  const projectRoot = getProjectRoot();
  process.stdout.write(
    `Orphaned ${plural(
      orphans.length,
      "directory",
      "directories",
    )} (no matching test):\n`,
  );
  for (const o of orphans) {
    const dir = absolute ? o.path : path.relative(projectRoot, o.path);
    process.stdout.write(
      `  ${dir}  (${o.entries} ${plural(o.entries, "entry", "entries")})\n`,
    );
  }
  process.stdout.write(
    "\nRun `vitiate paths --prune` to delete orphaned corpus dirs (add --all for testdata).\n",
  );
}

/** Emit the manifest and orphans as JSON. */
function renderPathsJson(rows: TestManifestRow[], orphans: OrphanDir[]): void {
  const tests = rows.map((r) => ({
    file: r.file,
    name: r.name,
    hashDir: r.hashDir,
    testDataDir: r.testDataDir,
    corpusDir: r.corpusDir,
    seeds: r.stats.seeds,
    crashes: r.stats.crashes,
    timeouts: r.stats.timeouts,
    ooms: r.stats.ooms,
    corpus: r.stats.corpus,
  }));
  const out = {
    tests,
    orphans: orphans.map((o) => ({
      kind: o.kind,
      hashDir: o.hashDir,
      path: o.path,
      entries: o.entries,
    })),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

/**
 * Serialize a `FuzzOptions` object into the `VITIATE_OPTIONS` env var read by
 * the child (see `getCliOptions` in config.ts). Returns an empty record when
 * there is nothing to pass, so callers can `Object.assign` unconditionally.
 */
function buildOptionsEnv(options: FuzzOptions): Record<string, string> {
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
function runFuzzSubcommand(parsed: InferValue<typeof fuzzParser>): void {
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
function runRegressionSubcommand(
  parsed: InferValue<typeof regressionParser>,
): void {
  const env: Record<string, string> = {};
  Object.assign(env, buildDetectorsEnv(parsed.detectors));
  spawnVitestWrapper(env, [...parsed.vitestArgs, ...parsed.positionalArgs]);
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
async function runReproduceSubcommand(
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
    process.stderr.write(
      "vitiate: error: vitest is required but not installed. Run `npm install -D vitest` first.\n",
    );
    process.exitCode = 1;
    return;
  }

  // Default to libFuzzer's `-timeout` value so a hung single-input replay is
  // bounded by the watchdog's `_exit` fallback rather than relying on vitest's
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
  const result = spawnSync(
    process.execPath,
    [vitestCli, "run", targetFilePath, "--test-name-pattern", testNamePattern],
    { env, stdio: "inherit" },
  );

  // Match libFuzzer's single-input reproduce contract: a clean replay exits 0,
  // and any reproduced failure (the one input crashed / tripped a detector /
  // timed out) exits with the crash code. Since exactly one input runs through
  // one test, a non-zero vitest status is the reproduced bug; we do not try to
  // separate a timeout here (that distinction lives in the libfuzzer supervisor).
  process.exitCode = result.status === 0 ? 0 : DEFAULT_ERROR_EXITCODE;
}

/**
 * Handle the optimize subcommand.
 */
function runOptimizeSubcommand(
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
  spawnVitestWrapper(env, [...parsed.vitestArgs, ...parsed.positionalArgs]);
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Show help and exit 0 when no subcommand is given
  if (rawArgs.length === 0) {
    rawArgs.push("--help");
  }

  const result = runSync(cli, {
    programName: "vitiate",
    args: rawArgs,
    brief: [text("Coverage-guided JavaScript fuzzer")],
    help: "option",
  } satisfies RunOptions);

  switch (result.subcommand) {
    case "fuzz":
      runFuzzSubcommand(result);
      return;
    case "regression":
      runRegressionSubcommand(result);
      return;
    case "reproduce":
      await runReproduceSubcommand(result);
      return;
    case "optimize":
      runOptimizeSubcommand(result);
      return;
    case "libfuzzer":
      await runLibfuzzerSubcommand(result.rest);
      return;
    case "init":
      await runInitSubcommand();
      return;
    case "paths":
      await runPathsSubcommand(result);
      return;
    default:
      result satisfies never;
  }
}

// Resolve symlinks so `pnpm exec vitiate` (which uses a symlinked bin) matches
// the real path that `import.meta.url` resolves to.
const resolvedArgv1 = (() => {
  try {
    return realpathSync(process.argv[1]!);
  } catch {
    return process.argv[1];
  }
})();

if (resolvedArgv1 === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
