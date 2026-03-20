import { describe, it, expect, afterEach } from "vitest";
import { COVERAGE_MAP_SIZE, getCliOptions } from "./config.js";
import { initGlobals } from "./globals.js";

describe("setup - regression mode", () => {
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCov = globalThis.__vitiate_cov;
  const originalTrace = globalThis.__vitiate_cmplog_write;
  const originalResetCounts = globalThis.__vitiate_cmplog_reset_counts;

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    globalThis.__vitiate_cov = originalCov;
    globalThis.__vitiate_cmplog_write = originalTrace;
    globalThis.__vitiate_cmplog_reset_counts = originalResetCounts;
  });

  it("initializes __vitiate_cov as Uint8Array in regression mode", async () => {
    delete process.env["VITIATE_FUZZ"];
    await initGlobals();
    expect(globalThis.__vitiate_cov).toBeInstanceOf(Uint8Array);
    expect(globalThis.__vitiate_cov.length).toBe(COVERAGE_MAP_SIZE);
  });

  it("initializes __vitiate_cmplog_write as no-op function in regression mode", async () => {
    delete process.env["VITIATE_FUZZ"];
    await initGlobals();
    expect(typeof globalThis.__vitiate_cmplog_write).toBe("function");
    // No-op: does not throw, returns void
    expect(
      globalThis.__vitiate_cmplog_write("hello", "hello", 0, 0),
    ).toBeUndefined();
    expect(globalThis.__vitiate_cmplog_write(1, 2, 0, 4)).toBeUndefined();
  });
});

describe("setup - fuzzing mode", () => {
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCov = globalThis.__vitiate_cov;
  const originalTrace = globalThis.__vitiate_cmplog_write;
  const originalResetCounts = globalThis.__vitiate_cmplog_reset_counts;

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    globalThis.__vitiate_cov = originalCov;
    globalThis.__vitiate_cmplog_write = originalTrace;
    globalThis.__vitiate_cmplog_reset_counts = originalResetCounts;
  });

  it("initializes __vitiate_cov as Buffer (napi-backed) in fuzzing mode", async () => {
    process.env["VITIATE_FUZZ"] = "1";
    await initGlobals();
    expect(globalThis.__vitiate_cov).toBeInstanceOf(Buffer);
    expect(globalThis.__vitiate_cov.length).toBe(COVERAGE_MAP_SIZE);
  });

  it("initializes __vitiate_cmplog_write as JS closure that writes to slot buffer in fuzzing mode", async () => {
    process.env["VITIATE_FUZZ"] = "1";
    await initGlobals();
    expect(typeof globalThis.__vitiate_cmplog_write).toBe("function");
    // Write call returns void, does not throw
    expect(
      globalThis.__vitiate_cmplog_write("hello", "hello", 0, 0),
    ).toBeUndefined();
  });
});

describe("setup - early init interaction", () => {
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCov = globalThis.__vitiate_cov;
  const originalTrace = globalThis.__vitiate_cmplog_write;
  const originalResetCounts = globalThis.__vitiate_cmplog_reset_counts;
  const originalTraceImpl = globalThis.__vitiate_cmplog_write_impl;
  const originalResetCountsImpl = globalThis.__vitiate_cmplog_reset_counts_impl;

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    globalThis.__vitiate_cov = originalCov;
    globalThis.__vitiate_cmplog_write = originalTrace;
    globalThis.__vitiate_cmplog_reset_counts = originalResetCounts;
    globalThis.__vitiate_cmplog_write_impl = originalTraceImpl;
    globalThis.__vitiate_cmplog_reset_counts_impl = originalResetCountsImpl;
  });

  it("buffer identity is preserved when configResolved runs before initGlobals in regression mode", async () => {
    delete process.env["VITIATE_FUZZ"];
    // Simulate configResolved setting up the coverage map early
    const earlyBuffer = new Uint8Array(COVERAGE_MAP_SIZE);
    globalThis.__vitiate_cov = earlyBuffer;

    await initGlobals();

    // initGlobals should NOT replace the buffer
    expect(globalThis.__vitiate_cov).toBe(earlyBuffer);
  });

  it("buffer identity is preserved when configResolved runs before initGlobals in fuzz mode", async () => {
    process.env["VITIATE_FUZZ"] = "1";
    // Simulate configResolved creating the Rust-backed buffer early
    const { createCoverageMap } = await import("@vitiate/engine");
    const earlyBuffer = createCoverageMap(COVERAGE_MAP_SIZE);
    globalThis.__vitiate_cov = earlyBuffer;

    await initGlobals();

    // initGlobals should NOT replace the buffer
    expect(globalThis.__vitiate_cov).toBe(earlyBuffer);
  });

  it("cmplog wrapper delegates to swapped implementation after initGlobals in fuzz mode", async () => {
    process.env["VITIATE_FUZZ"] = "1";

    // Simulate configResolved setting up forwarding wrappers
    globalThis.__vitiate_cmplog_write_impl = () => {};
    globalThis.__vitiate_cmplog_reset_counts_impl = () => {};

    const cachedWrite = (
      left: unknown,
      right: unknown,
      cmpId: number,
      opId: number,
    ) => {
      globalThis.__vitiate_cmplog_write_impl(left, right, cmpId, opId);
    };
    globalThis.__vitiate_cmplog_write = cachedWrite;
    globalThis.__vitiate_cmplog_reset_counts = () => {
      globalThis.__vitiate_cmplog_reset_counts_impl();
    };

    // Run initGlobals - should swap impl, not replace wrapper reference
    await initGlobals();

    // The wrapper reference should not have changed
    expect(globalThis.__vitiate_cmplog_write).toBe(cachedWrite);

    // But the impl should now be the real slot-buffer writer (callable)
    expect(typeof globalThis.__vitiate_cmplog_write_impl).toBe("function");
    expect(globalThis.__vitiate_cmplog_write("a", "b", 0, 0)).toBeUndefined();
  });
});

describe("setup - unconditional fuzz options reading", () => {
  const savedFuzzOptions = process.env["VITIATE_OPTIONS"];
  const savedFuzz = process.env["VITIATE_FUZZ"];

  afterEach(() => {
    if (savedFuzzOptions === undefined) {
      delete process.env["VITIATE_OPTIONS"];
    } else {
      process.env["VITIATE_OPTIONS"] = savedFuzzOptions;
    }
    if (savedFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = savedFuzz;
    }
  });

  it("detector config from VITIATE_OPTIONS is available in regression mode", () => {
    delete process.env["VITIATE_FUZZ"];
    process.env["VITIATE_OPTIONS"] = JSON.stringify({
      detectors: { prototypePollution: true },
    });
    const options = getCliOptions();
    expect(options.detectors?.prototypePollution).toBe(true);
  });

  it("default behavior preserved when VITIATE_OPTIONS is unset", () => {
    delete process.env["VITIATE_FUZZ"];
    delete process.env["VITIATE_OPTIONS"];
    const options = getCliOptions();
    expect(options.detectors).toBeUndefined();
  });
});
