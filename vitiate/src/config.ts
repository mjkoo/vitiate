/**
 * Mode detection and configuration for vitiate.
 */

export interface FuzzOptions {
  /** Maximum input length in bytes. */
  maxLen?: number;
  /**
   * Per-execution timeout in milliseconds.
   * Only applies to async fuzz targets; synchronous targets cannot be
   * preempted from the JS event loop.
   */
  timeoutMs?: number;
  /** Total fuzzing time limit in milliseconds. */
  maxTotalTimeMs?: number;
  /** Maximum number of fuzzing iterations. */
  runs?: number;
  /** RNG seed for reproducible fuzzing. */
  seed?: number;
}

export interface InstrumentOptions {
  /** Glob patterns for files to instrument. */
  include?: string[];
  /** Glob patterns for files to skip. */
  exclude?: string[];
}

export interface VitiatePluginOptions {
  instrument?: InstrumentOptions;
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

export function isFuzzingMode(): boolean {
  const val = process.env["VITIATE_FUZZ"];
  return val !== undefined && val !== "" && val !== "0" && val !== "false";
}

export function getFuzzPattern(): string | null {
  const val = process.env["VITIATE_FUZZ"];
  if (
    val === undefined ||
    val === "" ||
    val === "0" ||
    val === "false" ||
    val === "1"
  ) {
    return null;
  }
  return val;
}

function validateFuzzOptions(obj: Record<string, unknown>): FuzzOptions {
  const valid: FuzzOptions = {};
  const keys: (keyof FuzzOptions)[] = [
    "maxLen",
    "timeoutMs",
    "maxTotalTimeMs",
    "runs",
    "seed",
  ];
  for (const key of keys) {
    if (key in obj) {
      const val = obj[key];
      if (typeof val === "number" && Number.isFinite(val)) {
        // seed can be any integer; other fields must be positive
        if (key === "seed" || val > 0) {
          valid[key] = val;
        } else {
          process.stderr.write(
            `vitiate: warning: ignoring non-positive VITIATE_FUZZ_OPTIONS.${key}: ${val}\n`,
          );
        }
      } else if (val !== undefined && val !== null) {
        process.stderr.write(
          `vitiate: warning: ignoring non-numeric VITIATE_FUZZ_OPTIONS.${key}: ${JSON.stringify(val)}\n`,
        );
      }
    }
  }
  return valid;
}

export function getCliOptions(): FuzzOptions {
  const raw = process.env["VITIATE_FUZZ_OPTIONS"];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      process.stderr.write(
        `vitiate: warning: VITIATE_FUZZ_OPTIONS must be a JSON object\n`,
      );
      return {};
    }
    return validateFuzzOptions(parsed as Record<string, unknown>);
  } catch (e) {
    process.stderr.write(
      `vitiate: warning: invalid VITIATE_FUZZ_OPTIONS JSON: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return {};
  }
}

export const COVERAGE_MAP_SIZE = 65536;
