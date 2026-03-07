/**
 * Mode detection and configuration for vitiate.
 */

export interface FuzzOptions {
  /** Maximum input length in bytes. */
  maxLen?: number;
  /**
   * Per-execution timeout in milliseconds.
   * Enforced by the native watchdog thread for both sync and async targets.
   */
  timeoutMs?: number;
  /** Total fuzzing time limit in milliseconds. */
  maxTotalTimeMs?: number;
  /** Maximum number of fuzzing iterations. */
  runs?: number;
  /** RNG seed for reproducible fuzzing. */
  seed?: number;
  /** Maximum target re-executions during crash minimization. Default: 10,000. */
  minimizeBudget?: number;
  /** Wall-clock time limit in ms for crash minimization. Default: 5,000. */
  minimizeTimeLimitMs?: number;
  /**
   * Grimoire structure-aware fuzzing control.
   * `true` = force enable, `false` = force disable, absent = auto-detect from corpus UTF-8 content.
   */
  grimoire?: boolean;
  /**
   * Unicode-aware mutation control.
   * `true` = force enable, `false` = force disable, absent = auto-detect from corpus UTF-8 content.
   */
  unicode?: boolean;
  /**
   * REDQUEEN transform-aware mutation control.
   * `true` = force enable, `false` = force disable, absent = auto-detect (inverted: enabled for binary corpus).
   */
  redqueen?: boolean;
}

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

export function isFuzzingMode(): boolean {
  const val = process.env["VITIATE_FUZZ"];
  return val !== undefined && val !== "" && val !== "0" && val !== "false";
}

function validateFuzzOptions(obj: Record<string, unknown>): FuzzOptions {
  const valid: FuzzOptions = {};
  const numericKeys: (keyof Omit<
    FuzzOptions,
    "grimoire" | "unicode" | "redqueen"
  >)[] = [
    "maxLen",
    "timeoutMs",
    "maxTotalTimeMs",
    "runs",
    "seed",
    "minimizeBudget",
    "minimizeTimeLimitMs",
  ];
  for (const key of numericKeys) {
    if (key in obj) {
      const val = obj[key];
      if (typeof val === "number" && Number.isFinite(val)) {
        // seed can be any integer; other fields must be non-negative
        if (key === "seed" || val >= 0) {
          valid[key] = val;
        } else {
          process.stderr.write(
            `vitiate: warning: ignoring negative VITIATE_FUZZ_OPTIONS.${key}: ${val}\n`,
          );
        }
      } else if (val !== undefined && val !== null) {
        process.stderr.write(
          `vitiate: warning: ignoring non-numeric VITIATE_FUZZ_OPTIONS.${key}: ${JSON.stringify(val)}\n`,
        );
      }
    }
  }
  if ("grimoire" in obj && typeof obj["grimoire"] === "boolean") {
    valid.grimoire = obj["grimoire"];
  } else if (
    "grimoire" in obj &&
    obj["grimoire"] !== undefined &&
    obj["grimoire"] !== null
  ) {
    process.stderr.write(
      `vitiate: warning: ignoring non-boolean VITIATE_FUZZ_OPTIONS.grimoire: ${JSON.stringify(obj["grimoire"])}\n`,
    );
  }
  if ("unicode" in obj && typeof obj["unicode"] === "boolean") {
    valid.unicode = obj["unicode"];
  } else if (
    "unicode" in obj &&
    obj["unicode"] !== undefined &&
    obj["unicode"] !== null
  ) {
    process.stderr.write(
      `vitiate: warning: ignoring non-boolean VITIATE_FUZZ_OPTIONS.unicode: ${JSON.stringify(obj["unicode"])}\n`,
    );
  }
  if ("redqueen" in obj && typeof obj["redqueen"] === "boolean") {
    valid.redqueen = obj["redqueen"];
  } else if (
    "redqueen" in obj &&
    obj["redqueen"] !== undefined &&
    obj["redqueen"] !== null
  ) {
    process.stderr.write(
      `vitiate: warning: ignoring non-boolean VITIATE_FUZZ_OPTIONS.redqueen: ${JSON.stringify(obj["redqueen"])}\n`,
    );
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

/** Default max input length in bytes for shmem allocation. */
export const DEFAULT_MAX_INPUT_LEN = 4096;
