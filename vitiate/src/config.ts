/**
 * Mode detection and configuration for vitiate.
 */

import * as v from "valibot";

const NonNegativeNumber = v.pipe(v.number(), v.finite(), v.minValue(0));
const FiniteNumber = v.pipe(v.number(), v.finite());

const FuzzOptionsSchema = v.object({
  /** Maximum input length in bytes. */
  maxLen: v.optional(NonNegativeNumber),
  /**
   * Per-execution timeout in milliseconds.
   * Enforced by the native watchdog thread for both sync and async targets.
   */
  timeoutMs: v.optional(NonNegativeNumber),
  /** Total fuzzing time limit in milliseconds. */
  maxTotalTimeMs: v.optional(NonNegativeNumber),
  /** Maximum number of fuzzing iterations. */
  runs: v.optional(NonNegativeNumber),
  /** RNG seed for reproducible fuzzing. */
  seed: v.optional(FiniteNumber),
  /** Maximum target re-executions during crash minimization. Default: 10,000. */
  minimizeBudget: v.optional(NonNegativeNumber),
  /** Wall-clock time limit in ms for crash minimization. Default: 5,000. */
  minimizeTimeLimitMs: v.optional(NonNegativeNumber),
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

export function isSupervisorChild(): boolean {
  return envTruthy("VITIATE_SUPERVISOR");
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
  const raw = process.env["VITIATE_FUZZ_OPTIONS"];
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(
      `vitiate: warning: invalid VITIATE_FUZZ_OPTIONS JSON: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(
      `vitiate: warning: VITIATE_FUZZ_OPTIONS must be a JSON object\n`,
    );
    return {};
  }

  const result = v.safeParse(
    FuzzOptionsSchema,
    stripNulls(parsed as Record<string, unknown>),
  );
  if (result.success) return result.output;

  const flat = v.flatten(result.issues);
  for (const [key, messages] of Object.entries(flat.nested ?? {})) {
    process.stderr.write(
      `vitiate: warning: invalid VITIATE_FUZZ_OPTIONS.${key}: ${messages?.[0]}\n`,
    );
  }
  return {};
}

export const COVERAGE_MAP_SIZE = 65536;

/** Default max input length in bytes for shmem allocation. */
export const DEFAULT_MAX_INPUT_LEN = 4096;
