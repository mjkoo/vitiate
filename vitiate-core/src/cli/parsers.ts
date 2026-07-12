/**
 * Optique parser definitions for all CLI subcommands, plus the `-detectors`
 * flag parser shared by the subcommand handlers.
 */
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
import { lineBreak, text } from "@optique/core/message";
import type { FuzzOptions } from "../config.js";
import { KNOWN_DETECTOR_KEYS } from "../detectors/index.js";

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

/**
 * Flag names accepted by `libfuzzerParser`, exactly as they appear in the
 * `option(...)` definitions above (without the leading `-`). MUST stay in
 * sync with the parser: `parseArgs` (cli/libfuzzer.ts) uses this set to
 * warn-and-ignore unrecognized `-flag[=value]` tokens instead of aborting,
 * matching real libFuzzer's behavior for fuzzing-platform invocations.
 */
export const KNOWN_LIBFUZZER_FLAGS: ReadonlySet<string> = new Set([
  "max_len",
  "timeout",
  "runs",
  "seed",
  "max_total_time",
  "test",
  "minimize_budget",
  "minimize_time_limit",
  "artifact_prefix",
  "dict",
  "detectors",
  "fork",
  "jobs",
  "merge",
  "rss_limit_mb",
  "timeout_exitcode",
  "error_exitcode",
  "print_final_stats",
  "close_fd_mask",
  "reload",
]);

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

export const cliParser = or(
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
