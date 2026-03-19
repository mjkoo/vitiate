/**
 * Global coverage map and trace function initialization.
 *
 * In regression mode: uses plain JS (no napi dependency).
 * In fuzzing mode: uses napi-backed buffer and traceCmpRecord.
 */
import { isFuzzingMode, getCoverageMapSize } from "./config.js";

declare global {
  var __vitiate_cov: Uint8Array | Buffer;
  var __vitiate_trace_cmp_record: (
    left: unknown,
    right: unknown,
    cmpId: number,
    operatorId: number,
  ) => void;
}

/**
 * Return the current coverage map. Must be called after `initGlobals()`.
 */
export function getCoverageMap(): Uint8Array {
  return globalThis.__vitiate_cov;
}

export async function initGlobals(): Promise<void> {
  if (isFuzzingMode()) {
    const { createCoverageMap, traceCmpRecord } =
      await import("@vitiate/engine");
    globalThis.__vitiate_cov = createCoverageMap(getCoverageMapSize());
    globalThis.__vitiate_trace_cmp_record = traceCmpRecord;
  } else {
    globalThis.__vitiate_cov = new Uint8Array(getCoverageMapSize());
    globalThis.__vitiate_trace_cmp_record = (
      _left: unknown,
      _right: unknown,
      _cmpId: number,
      _operatorId: number,
    ) => {};
  }
}
