import { describe, it, expect, afterEach } from "vitest";
import { COVERAGE_MAP_SIZE } from "./config.js";
import { initGlobals } from "./globals.js";

describe("setup - regression mode", () => {
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCov = globalThis.__vitiate_cov;
  const originalTrace = globalThis.__vitiate_trace_cmp_record;

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    globalThis.__vitiate_cov = originalCov;
    globalThis.__vitiate_trace_cmp_record = originalTrace;
  });

  it("initializes __vitiate_cov as Uint8Array in regression mode", async () => {
    delete process.env["VITIATE_FUZZ"];
    await initGlobals();
    expect(globalThis.__vitiate_cov).toBeInstanceOf(Uint8Array);
    expect(globalThis.__vitiate_cov.length).toBe(COVERAGE_MAP_SIZE);
  });

  it("initializes __vitiate_trace_cmp_record as no-op function in regression mode", async () => {
    delete process.env["VITIATE_FUZZ"];
    await initGlobals();
    expect(typeof globalThis.__vitiate_trace_cmp_record).toBe("function");
    // No-op: does not throw, returns void
    expect(
      globalThis.__vitiate_trace_cmp_record("hello", "hello", 0, 0),
    ).toBeUndefined();
    expect(globalThis.__vitiate_trace_cmp_record(1, 2, 0, 4)).toBeUndefined();
  });
});

describe("setup - fuzzing mode", () => {
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCov = globalThis.__vitiate_cov;
  const originalTrace = globalThis.__vitiate_trace_cmp_record;

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    globalThis.__vitiate_cov = originalCov;
    globalThis.__vitiate_trace_cmp_record = originalTrace;
  });

  it("initializes __vitiate_cov as Buffer (napi-backed) in fuzzing mode", async () => {
    process.env["VITIATE_FUZZ"] = "1";
    await initGlobals();
    expect(globalThis.__vitiate_cov).toBeInstanceOf(Buffer);
    expect(globalThis.__vitiate_cov.length).toBe(COVERAGE_MAP_SIZE);
  });

  it("initializes __vitiate_trace_cmp_record as napi traceCmpRecord in fuzzing mode", async () => {
    process.env["VITIATE_FUZZ"] = "1";
    await initGlobals();
    expect(typeof globalThis.__vitiate_trace_cmp_record).toBe("function");
    // Record call returns void, does not throw
    expect(
      globalThis.__vitiate_trace_cmp_record("hello", "hello", 0, 0),
    ).toBeUndefined();
  });
});
