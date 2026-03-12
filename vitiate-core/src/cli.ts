/**
 * Standalone CLI: npx vitiate <subcommand> [args...]
 *
 * Subcommands:
 * - **init**: Discover fuzz tests, create seed directories, manage .gitignore.
 * - **fuzz**: Set VITIATE_FUZZ=1, spawn vitest run with *.fuzz.ts filter.
 * - **regression**: Spawn vitest run with *.fuzz.ts filter (no special env vars).
 * - **optimize**: Set VITIATE_OPTIMIZE=1, spawn vitest run with *.fuzz.ts filter.
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
} from "node:fs";
import { tmpdir } from "node:os";
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
import { MAX_RESPAWNS, runSupervisor } from "./supervisor.js";
import {
  DEFAULT_MAX_INPUT_LEN,
  isSupervisorChild,
  getCliIpc,
  setCliIpc,
  warnUnknownVitiateEnvVars,
  getProjectRoot,
  resolveVitestCli,
  type FuzzOptions,
} from "./config.js";
import { KNOWN_DETECTOR_KEYS } from "./detectors/index.js";
import { hashTestPath } from "./nix-base32.js";
import { getTestDataDir } from "./corpus.js";

export interface CliArgs {
  testFile: string;
  corpusDirs: readonly string[];
  testName?: string;
  artifactPrefix?: string;
  dictPath?: string;
  merge: boolean;
  fuzzOptions: FuzzOptions;
  forkExplicit?: boolean;
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
      description: [text("Total number of fuzzing iterations (0 = unlimited)")],
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
  // libFuzzer-compatible flags: accepted for OSS-Fuzz compatibility
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
  positionalArgs: withDefault(
    multiple(argument(string({ metavar: "VITEST_ARG" }))),
    [],
  ),
  vitestArgs: passThrough({
    format: "nextToken",
    description: vitestForwardingDescription,
  }),
});

const initParser = object({
  subcommand: constant("init" as const),
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
);

function warnUnsupportedFlags(
  parsed: InferValue<typeof libfuzzerParser>,
): void {
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
    fuzzOptions: {
      maxLen,
      timeoutMs: timeout != null ? timeout * 1000 : undefined,
      fuzzExecs: runs,
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
): Promise<void> {
  const shmem = ShmemHandle.allocate(maxInputLen);
  const relativeTestFilePath = path.relative(
    getProjectRoot(),
    path.resolve(testFile),
  );

  // When -test is provided, use it as the test name for artifact paths.
  // Otherwise, fall back to deriving from the filename (correct for the
  // single-test-per-file convention used in libFuzzer/OSS-Fuzz).
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

  if (result.crashed) {
    process.exitCode = 1;
  } else {
    process.exitCode = result.exitCode ?? 0;
  }
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

  process.exitCode = result.exitCode ?? 0;
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
  process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify(fuzzOptions);

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
  process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify(fuzzOptions);

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
  } = toCliArgs(
    runSync(libfuzzerParser, {
      programName: "vitiate libfuzzer",
      args,
      brief: [text("Coverage-guided JavaScript fuzzer (libFuzzer-compatible)")],
      description: [
        text(
          "Instruments JS/TS source with edge coverage counters via SWC and " +
            "drives mutation-based fuzzing via LibAFL. Accepts libFuzzer-compatible " +
            "flags. Configuration via per-test options, VITIATE_FUZZ_OPTIONS JSON " +
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
      await runMergeParentMode(testFile, corpusDirs, maxInputLen, testName);
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
    await runParentMode(testFile, maxInputLen, testName, artifactPrefix);
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
  const args = [vitestCli, "run", ".fuzz.ts", ...forwardedArgs];

  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });

  process.exitCode = result.status ?? 1;
}

/**
 * init subcommand: discover fuzz tests, create seed directories, manage .gitignore.
 */
async function runInitSubcommand(): Promise<void> {
  let createVitest: (typeof import("vitest/node"))["createVitest"];
  try {
    ({ createVitest } = await import("vitest/node"));
  } catch {
    process.stderr.write(
      "vitiate: error: vitest is required but not installed. Run `npm install -D vitest` first.\n",
    );
    process.exitCode = 1;
    return;
  }

  const vitest = await createVitest(
    "test",
    {
      include: ["**/*.fuzz.ts"],
    },
    {
      plugins: [vitiatePlugin({ instrument: {} })],
    },
  );

  try {
    const specs = await vitest.globTestSpecifications();
    if (specs.length === 0) {
      process.stdout.write("No *.fuzz.ts test files found.\n");
      return;
    }

    // Collect test specifications to discover test names
    await vitest.collectTests(specs);

    const projectRoot = getProjectRoot();
    const tests: {
      file: string;
      name: string;
      hashDir: string;
      seedPath: string;
    }[] = [];

    for (const module of vitest.state.getTestModules()) {
      const relativeFile = path.relative(projectRoot, module.moduleId);

      for (const testCase of module.children.allTests()) {
        const testName = testCase.fullName;
        const hashDir = hashTestPath(relativeFile, testName);
        const testDataDir = getTestDataDir(relativeFile, testName);
        const seedPath = path.join(testDataDir, "seeds");
        tests.push({ file: relativeFile, name: testName, hashDir, seedPath });
        mkdirSync(seedPath, { recursive: true });
      }
    }

    if (tests.length === 0) {
      process.stdout.write("No fuzz() tests found in *.fuzz.ts files.\n");
      return;
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
  } finally {
    await vitest.close();
  }
}

/**
 * Build env vars for detectors flag, shared by fuzz/regression/optimize.
 */
function buildDetectorsEnv(
  detectorsSpec: string | undefined,
): Record<string, string> {
  if (detectorsSpec === undefined) return {};
  const detectors = parseDetectorsFlag(detectorsSpec);
  return { VITIATE_FUZZ_OPTIONS: JSON.stringify({ detectors }) };
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

  // Detectors: merge into VITIATE_FUZZ_OPTIONS
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
 * Handle the optimize subcommand.
 */
function runOptimizeSubcommand(
  parsed: InferValue<typeof optimizeParser>,
): void {
  const env: Record<string, string> = { VITIATE_OPTIMIZE: "1" };
  Object.assign(env, buildDetectorsEnv(parsed.detectors));
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
    case "optimize":
      runOptimizeSubcommand(result);
      return;
    case "libfuzzer":
      await runLibfuzzerSubcommand(result.rest);
      return;
    case "init":
      await runInitSubcommand();
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
