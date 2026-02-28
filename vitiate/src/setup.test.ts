import { describe, it, expect, afterEach } from "vitest";
import { COVERAGE_MAP_SIZE } from "./config.js";
import { initGlobals } from "./globals.js";

describe("setup - regression mode", () => {
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCov = globalThis.__vitiate_cov;
  const originalTrace = globalThis.__vitiate_trace_cmp;

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    globalThis.__vitiate_cov = originalCov;
    globalThis.__vitiate_trace_cmp = originalTrace;
  });

  it("initializes __vitiate_cov as Uint8Array in regression mode", async () => {
    delete process.env["VITIATE_FUZZ"];
    await initGlobals();
    expect(globalThis.__vitiate_cov).toBeInstanceOf(Uint8Array);
    expect(globalThis.__vitiate_cov.length).toBe(COVERAGE_MAP_SIZE);
  });

  it("initializes __vitiate_trace_cmp as plain JS function in regression mode", async () => {
    delete process.env["VITIATE_FUZZ"];
    await initGlobals();
    expect(typeof globalThis.__vitiate_trace_cmp).toBe("function");
    expect(globalThis.__vitiate_trace_cmp("hello", "hello", 0, "===")).toBe(
      true,
    );
    expect(globalThis.__vitiate_trace_cmp("hello", "world", 0, "===")).toBe(
      false,
    );
    expect(globalThis.__vitiate_trace_cmp(1, 2, 0, "<")).toBe(true);
    expect(globalThis.__vitiate_trace_cmp(2, 1, 0, ">")).toBe(true);
    expect(globalThis.__vitiate_trace_cmp(1, 1, 0, "<=")).toBe(true);
    expect(globalThis.__vitiate_trace_cmp(1, 1, 0, ">=")).toBe(true);
    expect(globalThis.__vitiate_trace_cmp(1, 2, 0, "!==")).toBe(true);
  });
});

describe("setup - fuzzing mode", () => {
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCov = globalThis.__vitiate_cov;
  const originalTrace = globalThis.__vitiate_trace_cmp;

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    globalThis.__vitiate_cov = originalCov;
    globalThis.__vitiate_trace_cmp = originalTrace;
  });

  it("initializes __vitiate_cov as Buffer (napi-backed) in fuzzing mode", async () => {
    process.env["VITIATE_FUZZ"] = "1";
    await initGlobals();
    expect(globalThis.__vitiate_cov).toBeInstanceOf(Buffer);
    expect(globalThis.__vitiate_cov.length).toBe(COVERAGE_MAP_SIZE);
  });

  it("initializes __vitiate_trace_cmp as napi traceCmp in fuzzing mode", async () => {
    process.env["VITIATE_FUZZ"] = "1";
    await initGlobals();
    expect(typeof globalThis.__vitiate_trace_cmp).toBe("function");
    expect(globalThis.__vitiate_trace_cmp("hello", "hello", 0, "===")).toBe(
      true,
    );
    expect(globalThis.__vitiate_trace_cmp("hello", "world", 0, "===")).toBe(
      false,
    );
  });
});
