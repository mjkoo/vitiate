/**
 * Mode detection and configuration for vitiate.
 */

import path from "node:path";
import * as v from "valibot";
import { KNOWN_DETECTOR_KEYS } from "./detectors/index.js";

const NonNegativeInteger = v.pipe(
  v.number(),
  v.integer(),
  v.finite(),
  v.minValue(0),
);
const PositiveInteger = v.pipe(
  v.number(),
  v.integer(),
  v.finite(),
  v.minValue(1),
);
const AnyInteger = v.pipe(v.number(), v.integer(), v.finite());

/** Coerce a CLI string value to an array by splitting on path.delimiter. */
const StringOrStringArray = v.pipe(
  v.union([v.string(), v.array(v.string())]),
  v.transform((input) =>
    typeof input === "string" ? input.split(path.delimiter) : input,
  ),
);

const PathTraversalOptionsSchema = v.object({
  /** Paths (and subtrees) that are permitted. Defaults to ["/"]. */
  allowedPaths: v.optional(StringOrStringArray),
  /** Paths (and subtrees) that are denied. Denied takes priority over allowed. Defaults to ["/etc/passwd"] on POSIX, ["C:\\Windows\\System32\\drivers\\etc\\hosts"] on Windows. */
  deniedPaths: v.optional(StringOrStringArray),
});

const RedosOptionsSchema = v.object({
  /** Per-call wall-clock time threshold in milliseconds. Default: 100. */
  thresholdMs: v.optional(v.number()),
});

const SsrfOptionsSchema = v.object({
  /** Additional host specifications to block (CIDR, IP, hostname, wildcard domain). */
  blockedHosts: v.optional(StringOrStringArray),
  /** Host specifications to allow, overriding the blocklist. */
  allowedHosts: v.optional(StringOrStringArray),
});

const DetectorsSchema = v.pipe(
  v.record(v.string(), v.unknown()),
  v.transform((input) => {
    // Warn about unknown keys and extract only known keys
    for (const key of Object.keys(input)) {
      if (!KNOWN_DETECTOR_KEYS.has(key)) {
        process.stderr.write(
          `vitiate: warning: unknown detector "${key}" (ignoring)\n`,
        );
      }
    }
    const result: Record<string, unknown> = {};
    for (const key of KNOWN_DETECTOR_KEYS) {
      if (key in input) {
        result[key] = input[key];
      }
    }
    return result;
  }),
  v.object({
    prototypePollution: v.optional(v.boolean()),
    commandInjection: v.optional(v.boolean()),
    pathTraversal: v.optional(
      v.union([v.boolean(), PathTraversalOptionsSchema]),
    ),
    redos: v.optional(v.union([v.boolean(), RedosOptionsSchema])),
    ssrf: v.optional(v.union([v.boolean(), SsrfOptionsSchema])),
    unsafeEval: v.optional(v.boolean()),
  }),
);

const FuzzOptionsSchema = v.object({
  /** Maximum input length in bytes (must be at least 1). */
  maxLen: v.optional(PositiveInteger),
  /**
   * Per-execution timeout in milliseconds. 0 disables the timeout.
   * Enforced by the native watchdog thread for both sync and async targets.
   */
  timeoutMs: v.optional(NonNegativeInteger),
  /** Total fuzzing time limit in milliseconds. */
  fuzzTimeMs: v.optional(NonNegativeInteger),
  /** Maximum number of fuzzing iterations. 0 means unlimited. */
  fuzzExecs: v.optional(NonNegativeInteger),
  /** RNG seed for reproducible fuzzing. */
  seed: v.optional(AnyInteger),
  /** Maximum target re-executions during crash minimization. Default: 10,000. */
  minimizeBudget: v.optional(NonNegativeInteger),
  /** Wall-clock time limit in ms for crash minimization. 0 disables the limit. Default: 5,000. */
  minimizeTimeLimitMs: v.optional(NonNegativeInteger),
  /**
   * Grimoire structure-aware fuzzing control.
   * `true` = force enable, `false` = force disable, absent = auto-detect from corpus UTF-8 content.
   */
  grimoire: v.optional(v.boolean()),
  /**
   * Unicode-aware mutation control.
   * `true` = force enable, `false` = force disable, absent = auto-detect from corpus UTF-8 content.
   */
  unicode: v.optional(v.boolean()),
  /**
   * REDQUEEN transform-aware mutation control.
   * `true` = force enable, `false` = force disable, absent = auto-detect (inverted: enabled for binary corpus).
   */
  redqueen: v.optional(v.boolean()),
  /**
   * Startup banner control.
   * `true` = force show, `false` = force hide, absent = auto (show).
   * Controls the one-line startup banner only. Suppressed when `quiet` is `true`.
   */
  banner: v.optional(v.boolean()),
  /**
   * Quiet mode.
   * `true` = suppress banner, periodic status lines, and summary.
   * `false` = force verbose, absent = auto (not quiet).
   * Crash output always prints regardless of this flag.
   */
  quiet: v.optional(v.boolean()),
  /**
   * Crash termination control.
   * `true` = stop on first crash, `false` = continue after crash,
   * `"auto"` = mode-dependent default (vitest/fork → continue, CLI non-fork → stop).
   */
  stopOnCrash: v.optional(v.union([v.boolean(), v.literal("auto")])),
  /**
   * Maximum number of crashes to collect before terminating.
   * 0 = unlimited. Only effective when `stopOnCrash` is `false`.
   */
  maxCrashes: v.optional(NonNegativeInteger),
  /**
   * Per-detector enable/disable and configuration.
   * `boolean` per detector: `true` = enable, `false` = disable.
   * Options object for detectors that support configuration (e.g., pathTraversal).
   * Absent key = tier default (Tier 1 on, Tier 2 off).
   * Unknown keys are silently ignored for forward compatibility.
   */
  detectors: v.optional(DetectorsSchema),
});

export type FuzzOptions = v.InferOutput<typeof FuzzOptionsSchema>;

const CliIpcSchema = v.object({
  libfuzzerCompat: v.optional(v.boolean()),
  merge: v.optional(v.boolean()),
  mergeControlFile: v.optional(v.string()),
  corpusDirs: v.optional(v.array(v.string())),
  corpusOutputDir: v.optional(v.string()),
  artifactPrefix: v.optional(v.string()),
  dictionaryPath: v.optional(v.string()),
  forkExplicit: v.optional(v.boolean()),
});

export type CliIpc = v.InferOutput<typeof CliIpcSchema>;

export interface InstrumentOptions {
  /** Glob patterns for files to instrument. */
  include?: string[];
  /** Glob patterns for files to skip. */
  exclude?: string[];
}

export interface VitiatePluginOptions {
  /** File inclusion/exclusion patterns for SWC instrumentation. */
  instrument?: InstrumentOptions;
  /** Default fuzz options applied to all `fuzz()` tests (overridden by per-test and env options). */
  fuzz?: FuzzOptions;
  /** Cache directory path, resolved relative to project root. */
  cacheDir?: string;
  /** Coverage map size (number of edge counter slots). Default: 65536. Must be in [256, 4194304]. */
  coverageMapSize?: number;
}

const DEFAULT_INCLUDE = ["**/*.{js,ts,jsx,tsx,mjs,cjs,mts,cts}"];
const DEFAULT_EXCLUDE = ["**/node_modules/**"];

export function resolveInstrumentOptions(
  options?: InstrumentOptions,
): Required<InstrumentOptions> {
  return {
    include: options?.include ?? DEFAULT_INCLUDE,
    exclude: options?.exclude ?? DEFAULT_EXCLUDE,
  };
}

function envTruthy(key: string): boolean {
  const val = process.env[key];
  return val !== undefined && val !== "" && val !== "0" && val !== "false";
}

export function isFuzzingMode(): boolean {
  return envTruthy("VITIATE_FUZZ");
}

export function isOptimizeMode(): boolean {
  return envTruthy("VITIATE_OPTIMIZE");
}

export function isMergeMode(): boolean {
  return getCliIpc().merge ?? false;
}

/**
 * Check for mutually exclusive mode combinations and throw if detected.
 * Must be called at mode-detection boundaries.
 */
export function checkModeExclusion(): void {
  if (isOptimizeMode() && isFuzzingMode()) {
    throw new Error(
      "VITIATE_OPTIMIZE and VITIATE_FUZZ are mutually exclusive. " +
        "Optimize mode replays existing corpus entries; fuzz mode generates new ones.",
    );
  }
}

export function isSupervisorChild(): boolean {
  return envTruthy("VITIATE_SUPERVISOR");
}

export function isLibfuzzerCompat(): boolean {
  return getCliIpc().libfuzzerCompat ?? false;
}

/**
 * Read `VITIATE_FUZZ_TIME` env var (seconds) and convert to milliseconds.
 * Returns `undefined` when unset/empty, or when the value is invalid (warns on stderr).
 */
export function getFuzzTime(): number | undefined {
  const raw = process.env["VITIATE_FUZZ_TIME"];
  if (raw === undefined || raw === "") return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    process.stderr.write(
      `vitiate: warning: invalid VITIATE_FUZZ_TIME value: ${JSON.stringify(raw)} (expected non-negative integer seconds)\n`,
    );
    return undefined;
  }

  return parsed * 1000;
}

/**
 * Read `VITIATE_FUZZ_EXECS` env var and return as a number.
 * Returns `undefined` when unset/empty, or when the value is invalid (warns on stderr).
 */
export function getFuzzExecs(): number | undefined {
  const raw = process.env["VITIATE_FUZZ_EXECS"];
  if (raw === undefined || raw === "") return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    process.stderr.write(
      `vitiate: warning: invalid VITIATE_FUZZ_EXECS value: ${JSON.stringify(raw)} (expected non-negative integer)\n`,
    );
    return undefined;
  }

  return parsed;
}

/**
 * Read `VITIATE_MAX_CRASHES` env var and return as a number.
 * Returns `undefined` when unset/empty, or when the value is invalid (warns on stderr).
 */
export function getMaxCrashes(): number | undefined {
  const raw = process.env["VITIATE_MAX_CRASHES"];
  if (raw === undefined || raw === "") return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    process.stderr.write(
      `vitiate: warning: invalid VITIATE_MAX_CRASHES value: ${JSON.stringify(raw)} (expected non-negative integer)\n`,
    );
    return undefined;
  }

  return parsed;
}

export function getDictionaryPathEnv(): string | undefined {
  return getCliIpc().dictionaryPath;
}

export function getCorpusOutputDir(): string | undefined {
  return getCliIpc().corpusOutputDir;
}

export function getArtifactPrefix(): string | undefined {
  return getCliIpc().artifactPrefix;
}

export function getCorpusDirs(): string[] | undefined {
  return getCliIpc().corpusDirs;
}

export function getMergeControlFile(): string | undefined {
  return getCliIpc().mergeControlFile;
}

let cachedCliIpc: CliIpc | undefined;
let cachedCliIpcRaw: string | undefined;

export function getCliIpc(): CliIpc {
  const raw = process.env["VITIATE_CLI_IPC"];
  if (raw === cachedCliIpcRaw && cachedCliIpc !== undefined)
    return cachedCliIpc;
  cachedCliIpcRaw = raw;

  if (!raw) return (cachedCliIpc = {});

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(
      `vitiate: warning: invalid VITIATE_CLI_IPC JSON: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return (cachedCliIpc = {});
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(
      `vitiate: warning: VITIATE_CLI_IPC must be a JSON object\n`,
    );
    return (cachedCliIpc = {});
  }

  const result = v.safeParse(
    CliIpcSchema,
    stripNulls(parsed as Record<string, unknown>),
  );
  if (result.success) {
    return (cachedCliIpc = result.output);
  }

  const flat = v.flatten(result.issues);
  if (flat.nested) {
    for (const [key, messages] of Object.entries(flat.nested)) {
      if (!messages?.length) continue;
      process.stderr.write(
        `vitiate: warning: invalid VITIATE_CLI_IPC.${key}: ${messages[0]}\n`,
      );
    }
  } else if (flat.root) {
    process.stderr.write(
      `vitiate: warning: invalid VITIATE_CLI_IPC: ${flat.root[0]}\n`,
    );
  }
  return (cachedCliIpc = {});
}

export function setCliIpc(ipc: CliIpc): void {
  const serialized = JSON.stringify(ipc);
  process.env["VITIATE_CLI_IPC"] = serialized;
  cachedCliIpcRaw = serialized;
  cachedCliIpc = ipc;
}

let resolvedProjectRoot: string | undefined;

export function setProjectRoot(root: string): void {
  resolvedProjectRoot = root;
}

export function getProjectRoot(): string {
  return resolvedProjectRoot ?? process.cwd();
}

export function resetProjectRoot(): void {
  resolvedProjectRoot = undefined;
}

let resolvedCacheDir: string | undefined;

export function setCacheDir(dir: string): void {
  resolvedCacheDir = dir;
}

export function getResolvedCacheDir(): string | undefined {
  return resolvedCacheDir;
}

export function resetCacheDir(): void {
  resolvedCacheDir = undefined;
}

const KNOWN_VITIATE_ENV_VARS = new Set([
  "VITIATE_FUZZ",
  "VITIATE_FUZZ_EXECS",
  "VITIATE_FUZZ_TIME",
  "VITIATE_MAX_CRASHES",
  "VITIATE_OPTIMIZE",
  "VITIATE_SUPERVISOR",
  "VITIATE_SHMEM",
  "VITIATE_FUZZ_OPTIONS",
  "VITIATE_CLI_IPC",
  "VITIATE_DEBUG",
]);

export function isDebugMode(): boolean {
  return envTruthy("VITIATE_DEBUG");
}

export function warnUnknownVitiateEnvVars(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VITIATE_") && !KNOWN_VITIATE_ENV_VARS.has(key)) {
      process.stderr.write(
        `vitiate: warning: unknown environment variable: ${key}\n`,
      );
    }
  }
}

/**
 * Strip null values from a parsed JSON object. JSON uses null for "absent"
 * but valibot's optional() only accepts undefined, so we normalize before parsing.
 */
function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, val]) => val !== null)
      .map(([key, val]) => [
        key,
        typeof val === "object" && val !== null && !Array.isArray(val)
          ? stripNulls(val as Record<string, unknown>)
          : val,
      ]),
  );
}

export function getCliOptions(): FuzzOptions {
  let options: FuzzOptions = {};

  const raw = process.env["VITIATE_FUZZ_OPTIONS"];
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(
        `vitiate: warning: invalid VITIATE_FUZZ_OPTIONS JSON: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      parsed = null;
    }

    if (parsed !== null) {
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        process.stderr.write(
          `vitiate: warning: VITIATE_FUZZ_OPTIONS must be a JSON object\n`,
        );
      } else {
        const result = v.safeParse(
          FuzzOptionsSchema,
          stripNulls(parsed as Record<string, unknown>),
        );
        if (result.success) {
          options = result.output;
        } else {
          const flat = v.flatten(result.issues);
          if (flat.nested) {
            for (const [key, messages] of Object.entries(flat.nested)) {
              if (!messages?.length) continue;
              process.stderr.write(
                `vitiate: warning: invalid VITIATE_FUZZ_OPTIONS.${key}: ${messages[0]}\n`,
              );
            }
          } else if (flat.root) {
            process.stderr.write(
              `vitiate: warning: invalid VITIATE_FUZZ_OPTIONS: ${flat.root[0]}\n`,
            );
          }
        }
      }
    }
  }

  const fuzzTimeOverride = getFuzzTime();
  if (fuzzTimeOverride !== undefined) {
    options = { ...options, fuzzTimeMs: fuzzTimeOverride };
  }

  const fuzzExecsOverride = getFuzzExecs();
  if (fuzzExecsOverride !== undefined) {
    options = { ...options, fuzzExecs: fuzzExecsOverride };
  }

  const maxCrashesOverride = getMaxCrashes();
  if (maxCrashesOverride !== undefined) {
    options = { ...options, maxCrashes: maxCrashesOverride };
  }

  return options;
}

export const COVERAGE_MAP_SIZE = 65536;

const MIN_COVERAGE_MAP_SIZE = 256;
const MAX_COVERAGE_MAP_SIZE = 4_194_304;

let resolvedCoverageMapSize: number | undefined;

export function setCoverageMapSize(size: number): void {
  if (
    !Number.isInteger(size) ||
    size < MIN_COVERAGE_MAP_SIZE ||
    size > MAX_COVERAGE_MAP_SIZE
  ) {
    throw new Error(
      `vitiate: coverageMapSize must be an integer in [${MIN_COVERAGE_MAP_SIZE}, ${MAX_COVERAGE_MAP_SIZE}], got ${size}`,
    );
  }
  if ((size & (size - 1)) !== 0) {
    process.stderr.write(
      `vitiate: warning: coverageMapSize ${size} is not a power of two; this is allowed but may reduce hash distribution quality\n`,
    );
  }
  resolvedCoverageMapSize = size;
}

export function getCoverageMapSize(): number {
  return resolvedCoverageMapSize ?? COVERAGE_MAP_SIZE;
}

/**
 * Reset the resolved coverage map size. For testing only.
 */
export function resetCoverageMapSize(): void {
  resolvedCoverageMapSize = undefined;
}

/**
 * Resolve the tri-state `stopOnCrash` option to a concrete boolean.
 *
 * Resolution rules for `"auto"` (or `undefined`, which defaults to `"auto"`):
 * - Vitest mode (`libfuzzerCompat=false`): resolves to `false` (continue after crash).
 * - CLI mode with explicit `-fork` flag: resolves to `false`.
 * - CLI mode without `-fork` flag: resolves to `true` (stop on first crash).
 *
 * Explicit `true` or `false` passes through unchanged.
 */
export function resolveStopOnCrash(
  stopOnCrash: boolean | "auto" | undefined,
  libfuzzerCompat: boolean,
  forkExplicit: boolean | undefined,
): boolean {
  if (stopOnCrash === true || stopOnCrash === false) {
    return stopOnCrash;
  }
  // "auto" or undefined: mode-dependent default
  if (!libfuzzerCompat) {
    // Vitest mode: continue after crash
    return false;
  }
  // CLI mode: depends on fork flag
  return !forkExplicit;
}

/** Default max input length in bytes for shmem allocation. */
export const DEFAULT_MAX_INPUT_LEN = 4096;
