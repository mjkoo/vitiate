/**
 * Global coverage map and trace function initialization.
 *
 * In regression mode: uses plain JS (no napi dependency).
 * In fuzzing mode: uses napi-backed buffer for coverage and a shared-memory
 * slot buffer for zero-NAPI comparison tracing.
 */
import { isFuzzingMode, getCoverageMapSize } from "./config.js";

/**
 * Slot size in bytes (80 bytes per comparison entry).
 * Must match `SLOT_SIZE` in `vitiate-engine/src/cmplog.rs`.
 */
export const SLOT_SIZE = 80;

/**
 * Total slot buffer size (256 KB).
 * Must match `SLOT_BUFFER_SIZE` in `vitiate-engine/src/cmplog.rs`.
 */
export const SLOT_BUFFER_SIZE = 256 * 1024;

/**
 * Maximum number of slots in the buffer. `| 0` truncates to match Rust integer division.
 * Must match `MAX_SLOTS` in `vitiate-engine/src/cmplog.rs`.
 */
export const MAX_SLOTS = (SLOT_BUFFER_SIZE / SLOT_SIZE) | 0;

/** Maximum entries per comparison site per iteration. */
export const MAX_ENTRIES_PER_SITE = 8;

/** Number of per-site count slots. Must be a power of two (hash mask). */
export const SITE_COUNT_SLOTS = 512;

declare global {
  var __vitiate_cov: Uint8Array | Buffer;
  var __vitiate_cmplog_write: (
    left: unknown,
    right: unknown,
    cmpId: number,
    opId: number,
  ) => void;
  var __vitiate_cmplog_reset_counts: () => void;
}

/**
 * Return the current coverage map. Must be called after `initGlobals()`.
 */
export function getCoverageMap(): Uint8Array {
  return globalThis.__vitiate_cov;
}

export interface CmplogWriteFunctions {
  write: (left: unknown, right: unknown, cmpId: number, opId: number) => void;
  resetCounts: () => void;
}

/**
 * Create the CmpLog write function and count-reset function over the given
 * shared-memory buffers. Exported for testability - `initGlobals()` calls
 * this internally with the NAPI-backed buffers.
 */
export function createCmplogWriteFunctions(
  slotBuffer: Uint8Array,
  writePointerBuffer: Uint8Array,
): CmplogWriteFunctions {
  const buf = new Uint8Array(
    slotBuffer.buffer,
    slotBuffer.byteOffset,
    slotBuffer.byteLength,
  );
  const view = new DataView(
    slotBuffer.buffer,
    slotBuffer.byteOffset,
    slotBuffer.byteLength,
  );
  const wptr = new Uint32Array(
    writePointerBuffer.buffer,
    writePointerBuffer.byteOffset,
    1,
  );

  // JS-local per-site counts (reset at each iteration start).
  const counts = new Uint8Array(SITE_COUNT_SLOTS);
  const encoder = new TextEncoder();

  const resetCounts = (): void => {
    counts.fill(0);
  };

  // Non-null assertions (`!`) below are safe: `wptr` is a Uint32Array(1) so
  // index 0 always exists, and `si` is masked to SITE_COUNT_SLOTS-1 which is
  // always within the `counts` Uint8Array bounds.
  const write = (
    left: unknown,
    right: unknown,
    cmpId: number,
    opId: number,
  ): void => {
    const slot = wptr[0]!;
    if (slot >= MAX_SLOTS) return; // covers buffer-full AND disabled

    const si = cmpId & (SITE_COUNT_SLOTS - 1);
    if (counts[si]! >= MAX_ENTRIES_PER_SITE) return;

    const off = slot * SLOT_SIZE;
    view.setUint32(off, cmpId, true);
    buf[off + 4] = opId;

    const lt = typeof left;
    if (lt === "number") {
      buf[off + 5] = 1;
      view.setFloat64(off + 8, left as number, true);
    } else if (lt === "string") {
      buf[off + 5] = 2;
      const n = encoder.encodeInto(
        left as string,
        buf.subarray(off + 8, off + 40),
      ).written;
      buf[off + 7] = n;
    } else {
      return; // skip unsupported types
    }

    const rt = typeof right;
    if (rt === "number") {
      buf[off + 6] = 1;
      view.setFloat64(off + 41, right as number, true);
    } else if (rt === "string") {
      buf[off + 6] = 2;
      const n = encoder.encodeInto(
        right as string,
        buf.subarray(off + 41, off + 73),
      ).written;
      buf[off + 40] = n;
    } else {
      return; // skip unsupported types
    }

    wptr[0] = slot + 1;
    counts[si] = counts[si]! + 1;
  };

  return { write, resetCounts };
}

export async function initGlobals(): Promise<void> {
  if (isFuzzingMode()) {
    const { createCoverageMap, cmplogGetSlotBuffer, cmplogGetWritePointer } =
      await import("@vitiate/engine");
    globalThis.__vitiate_cov = createCoverageMap(getCoverageMapSize());

    const slotBuffer = cmplogGetSlotBuffer();
    const writePointerBuffer = cmplogGetWritePointer();

    const { write, resetCounts } = createCmplogWriteFunctions(
      slotBuffer,
      writePointerBuffer,
    );
    globalThis.__vitiate_cmplog_write = write;
    globalThis.__vitiate_cmplog_reset_counts = resetCounts;
  } else {
    globalThis.__vitiate_cov = new Uint8Array(getCoverageMapSize());
    globalThis.__vitiate_cmplog_write = (
      _left: unknown,
      _right: unknown,
      _cmpId: number,
      _opId: number,
    ) => {};
    globalThis.__vitiate_cmplog_reset_counts = () => {};
  }
}
