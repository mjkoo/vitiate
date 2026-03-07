/**
 * Global coverage map and trace function initialization.
 *
 * In regression mode: uses plain JS (no napi dependency).
 * In fuzzing mode: uses napi-backed buffer and traceCmp.
 */
import { isFuzzingMode, getCoverageMapSize } from "./config.js";

declare global {
  var __vitiate_cov: Uint8Array | Buffer;
  var __vitiate_trace_cmp: (
    left: unknown,
    right: unknown,
    cmpId: number,
    op: string,
  ) => boolean;
}

/**
 * Return the current coverage map. Must be called after `initGlobals()`.
 */
export function getCoverageMap(): Uint8Array {
  return globalThis.__vitiate_cov;
}

type Orderable = string | number | bigint;

export async function initGlobals(): Promise<void> {
  if (isFuzzingMode()) {
    const { createCoverageMap, traceCmp } = await import("vitiate-napi");
    globalThis.__vitiate_cov = createCoverageMap(getCoverageMapSize());
    globalThis.__vitiate_trace_cmp = traceCmp;
  } else {
    const ops: Record<string, (a: unknown, b: unknown) => boolean> = {
      "===": (a, b) => a === b,
      "!==": (a, b) => a !== b,
      "==": (a, b) => a == b,
      "!=": (a, b) => a != b,
      "<": (a, b) => (a as Orderable) < (b as Orderable),
      ">": (a, b) => (a as Orderable) > (b as Orderable),
      "<=": (a, b) => (a as Orderable) <= (b as Orderable),
      ">=": (a, b) => (a as Orderable) >= (b as Orderable),
    };
    globalThis.__vitiate_cov = new Uint8Array(getCoverageMapSize());
    globalThis.__vitiate_trace_cmp = (
      left: unknown,
      right: unknown,
      _cmpId: number,
      op: string,
    ): boolean => {
      const fn = ops[op];
      if (fn === undefined) {
        throw new Error(`vitiate: unknown comparison operator: ${op}`);
      }
      return fn(left, right);
    };
  }
}
