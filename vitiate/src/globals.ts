/**
 * Global coverage map and trace function initialization.
 *
 * In regression mode: uses plain JS (no napi dependency).
 * In fuzzing mode: uses napi-backed buffer and traceCmp.
 */
import { isFuzzingMode, COVERAGE_MAP_SIZE } from "./config.js";

declare global {
  var __vitiate_cov: Uint8Array | Buffer;
  var __vitiate_trace_cmp: (
    left: unknown,
    right: unknown,
    cmpId: number,
    op: string,
  ) => boolean;
}

const ops: Record<string, (a: unknown, b: unknown) => boolean> = {
  "===": (a, b) => a === b,
  "!==": (a, b) => a !== b,
  "==": (a, b) => a == b,
  "!=": (a, b) => a != b,
  "<": (a, b) => (a as number) < (b as number),
  ">": (a, b) => (a as number) > (b as number),
  "<=": (a, b) => (a as number) <= (b as number),
  ">=": (a, b) => (a as number) >= (b as number),
};

export async function initGlobals(): Promise<void> {
  if (isFuzzingMode()) {
    const { createCoverageMap, traceCmp } = await import("vitiate-napi");
    globalThis.__vitiate_cov = createCoverageMap(COVERAGE_MAP_SIZE);
    globalThis.__vitiate_trace_cmp = traceCmp;
  } else {
    globalThis.__vitiate_cov = new Uint8Array(COVERAGE_MAP_SIZE);
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
