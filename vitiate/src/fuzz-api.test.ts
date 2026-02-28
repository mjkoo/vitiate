import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fuzz, shouldEnterFuzzLoop } from "./fuzz.js";

describe("fuzz API", () => {
  it("fuzz is a function", () => {
    expect(typeof fuzz).toBe("function");
  });

  it("fuzz.skip is a function", () => {
    expect(typeof fuzz.skip).toBe("function");
  });

  it("fuzz.only is a function", () => {
    expect(typeof fuzz.only).toBe("function");
  });

  it("fuzz.todo is a function", () => {
    expect(typeof fuzz.todo).toBe("function");
  });
});

// fuzz() calls must be at the describe level (not inside test/it),
// because fuzz() delegates to test() which registers with vitest's runner.

describe("fuzz regression mode - smoke test with no corpus", () => {
  // This registers a test via fuzz() that runs in regression mode.
  // With no corpus, it runs the target once with an empty buffer.
  fuzz("smoke-test-empty-buffer", (data) => {
    expect(data.length).toBe(0);
  });
});

describe("fuzz regression mode - replay corpus files", () => {
  const cacheDir = path.join(
    tmpdir(),
    `vitiate-fuzz-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const originalCacheDir = process.env["VITIATE_CACHE_DIR"];

  beforeAll(() => {
    const seedDir = path.join(cacheDir, "regression-replay");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(path.join(seedDir, "seed-hello"), "hello");
    process.env["VITIATE_CACHE_DIR"] = cacheDir;
  });

  afterAll(() => {
    if (originalCacheDir === undefined) {
      delete process.env["VITIATE_CACHE_DIR"];
    } else {
      process.env["VITIATE_CACHE_DIR"] = originalCacheDir;
    }
    rmSync(cacheDir, { recursive: true, force: true });
  });

  fuzz("regression-replay", (data) => {
    expect(data.length).toBeGreaterThan(0);
  });
});

describe("shouldEnterFuzzLoop", () => {
  const originalFuzz = process.env["VITIATE_FUZZ"];

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
  });

  it("returns false when VITIATE_FUZZ is unset", () => {
    delete process.env["VITIATE_FUZZ"];
    expect(shouldEnterFuzzLoop("any-test")).toBe(false);
  });

  it("returns true for all tests when VITIATE_FUZZ=1", () => {
    process.env["VITIATE_FUZZ"] = "1";
    expect(shouldEnterFuzzLoop("any-test")).toBe(true);
    expect(shouldEnterFuzzLoop("other-test")).toBe(true);
  });

  it("matches tests via regex pattern", () => {
    process.env["VITIATE_FUZZ"] = "parser";
    expect(shouldEnterFuzzLoop("parser-test")).toBe(true);
    expect(shouldEnterFuzzLoop("my-parser")).toBe(true);
  });

  it("does not match non-matching pattern", () => {
    process.env["VITIATE_FUZZ"] = "parser";
    expect(shouldEnterFuzzLoop("lexer-test")).toBe(false);
  });

  it("falls back to substring match on invalid regex", () => {
    process.env["VITIATE_FUZZ"] = "[invalid(";
    expect(shouldEnterFuzzLoop("test-[invalid(-foo")).toBe(true);
    expect(shouldEnterFuzzLoop("other-test")).toBe(false);
  });
});

describe("fuzz regression mode - loads extra corpus dirs", () => {
  const tmpBase = path.join(
    tmpdir(),
    `vitiate-fuzz-extra-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const extraDir = path.join(tmpBase, "extra");
  const originalCorpusDirs = process.env["VITIATE_CORPUS_DIRS"];

  beforeAll(() => {
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(path.join(extraDir, "seed-extra"), "extra-data");
    process.env["VITIATE_CORPUS_DIRS"] = extraDir;
  });

  afterAll(() => {
    if (originalCorpusDirs === undefined) {
      delete process.env["VITIATE_CORPUS_DIRS"];
    } else {
      process.env["VITIATE_CORPUS_DIRS"] = originalCorpusDirs;
    }
    rmSync(tmpBase, { recursive: true, force: true });
  });

  const seen: string[] = [];
  fuzz("extra-corpus-regression", (data) => {
    seen.push(data.toString());
  });

  it("replayed at least the extra corpus entry", () => {
    expect(seen).toContain("extra-data");
  });
});

// fuzz.skip and fuzz.todo must also be at the describe level
describe("fuzz modifiers", () => {
  fuzz.skip("this-is-skipped", (_data) => {
    throw new Error("should not run");
  });

  fuzz.todo("this-is-a-todo");
});
