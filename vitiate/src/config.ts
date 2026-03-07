/**
 * Mode detection and configuration for vitiate.
 */

import * as v from "valibot";

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
  /** Maximum number of fuzzing iterations. */
  runs: v.optional(NonNegativeInteger),
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
});

export type FuzzOptions = v.InferOutput<typeof FuzzOptionsSchema>;

export interface FuzzDefaults extends FuzzOptions {
  /** Cache directory path, resolved relative to project root. */
  cacheDir?: string;
}

export interface InstrumentOptions {
  /** Glob patterns for files to instrument. */
  include?: string[];
  /** Glob patterns for files to skip. */
  exclude?: string[];
}

export interface VitiatePluginOptions {
  instrument?: InstrumentOptions;
  fuzz?: FuzzDefaults;
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
  return envTruthy("VITIATE_MERGE");
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
  return envTruthy("VITIATE_LIBFUZZER_COMPAT");
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

export function getDictionaryPathEnv(): string | undefined {
  return process.env["VITIATE_DICTIONARY_PATH"] || undefined;
}

export function getCorpusOutputDir(): string | undefined {
  return process.env["VITIATE_CORPUS_OUTPUT_DIR"] || undefined;
}

export function getArtifactPrefix(): string | undefined {
  return process.env["VITIATE_ARTIFACT_PREFIX"] || undefined;
}

/**
 * Strip null values from a parsed JSON object. JSON uses null for "absent"
 * but valibot's optional() only accepts undefined, so we normalize before parsing.
 */
function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, val]) => val !== null),
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

  return options;
}

export const COVERAGE_MAP_SIZE = 65536;

/** Default max input length in bytes for shmem allocation. */
export const DEFAULT_MAX_INPUT_LEN = 4096;
