import { describe, it, expect, afterEach } from "vitest";
import {
  isFuzzingMode,
  getCliOptions,
  resolveInstrumentOptions,
  COVERAGE_MAP_SIZE,
} from "./config.js";

describe("config", () => {
  const originalEnv = process.env["VITIATE_FUZZ"];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalEnv;
    }
  });

  describe("isFuzzingMode", () => {
    it("returns false when VITIATE_FUZZ is not set", () => {
      delete process.env["VITIATE_FUZZ"];
      expect(isFuzzingMode()).toBe(false);
    });

    it("returns false when VITIATE_FUZZ is empty", () => {
      process.env["VITIATE_FUZZ"] = "";
      expect(isFuzzingMode()).toBe(false);
    });

    it("returns false when VITIATE_FUZZ is 0", () => {
      process.env["VITIATE_FUZZ"] = "0";
      expect(isFuzzingMode()).toBe(false);
    });

    it("returns false when VITIATE_FUZZ is false", () => {
      process.env["VITIATE_FUZZ"] = "false";
      expect(isFuzzingMode()).toBe(false);
    });

    it("returns true when VITIATE_FUZZ is 1", () => {
      process.env["VITIATE_FUZZ"] = "1";
      expect(isFuzzingMode()).toBe(true);
    });

    it("returns true when VITIATE_FUZZ is a pattern", () => {
      process.env["VITIATE_FUZZ"] = "parser";
      expect(isFuzzingMode()).toBe(true);
    });
  });

  describe("getCliOptions", () => {
    const originalOpts = process.env["VITIATE_FUZZ_OPTIONS"];

    afterEach(() => {
      if (originalOpts === undefined) {
        delete process.env["VITIATE_FUZZ_OPTIONS"];
      } else {
        process.env["VITIATE_FUZZ_OPTIONS"] = originalOpts;
      }
    });

    it("returns empty object when env var is not set", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      expect(getCliOptions()).toEqual({});
    });

    it("returns empty object when env var is empty", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = "";
      expect(getCliOptions()).toEqual({});
    });

    it("parses valid JSON options", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        runs: 1000,
        maxLen: 4096,
        seed: 42,
      });
      const opts = getCliOptions();
      expect(opts.runs).toBe(1000);
      expect(opts.maxLen).toBe(4096);
      expect(opts.seed).toBe(42);
    });

    it("rejects the whole object when any field is invalid and warns per field", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          runs: "not-a-number",
          maxLen: 4096,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.runs");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("rejects negative numbers for non-seed fields and warns on stderr", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          runs: -1,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.runs");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("preserves zero values for fields where zero means unlimited", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          timeoutMs: 0,
          minimizeTimeLimitMs: 0,
        });
        const opts = getCliOptions();
        expect(opts.timeoutMs).toBe(0);
        expect(opts.minimizeTimeLimitMs).toBe(0);
        expect(chunks.length).toBe(0);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("parses grimoire: true", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        grimoire: true,
      });
      expect(getCliOptions()).toEqual({ grimoire: true });
    });

    it("parses grimoire: false", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        grimoire: false,
      });
      expect(getCliOptions()).toEqual({ grimoire: false });
    });

    it("rejects the whole object for non-boolean grimoire and warns", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          grimoire: "true",
          runs: 100,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.grimoire");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("silently omits grimoire: null (JSON null treated as absent)", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          grimoire: null,
          runs: 100,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({ runs: 100 });
        expect(chunks.length).toBe(0);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("omits grimoire when key is absent from input", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({ runs: 100 });
      const opts = getCliOptions();
      expect(opts).toEqual({ runs: 100 });
      expect("grimoire" in opts).toBe(false);
    });

    it("parses unicode: true", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        unicode: true,
      });
      expect(getCliOptions()).toEqual({ unicode: true });
    });

    it("parses unicode: false", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        unicode: false,
      });
      expect(getCliOptions()).toEqual({ unicode: false });
    });

    it("rejects the whole object for non-boolean unicode and warns", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          unicode: "true",
          runs: 100,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.unicode");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("silently omits unicode: null", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          unicode: null,
          runs: 100,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({ runs: 100 });
        expect(chunks.length).toBe(0);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("omits unicode when key is absent from input", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({ runs: 100 });
      const opts = getCliOptions();
      expect("unicode" in opts).toBe(false);
    });

    it("parses redqueen: true", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        redqueen: true,
      });
      expect(getCliOptions()).toEqual({ redqueen: true });
    });

    it("parses redqueen: false", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        redqueen: false,
      });
      expect(getCliOptions()).toEqual({ redqueen: false });
    });

    it("rejects the whole object for non-boolean redqueen and warns", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          redqueen: "true",
          runs: 100,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.redqueen");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("omits redqueen when key is absent from input", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({ runs: 100 });
      const opts = getCliOptions();
      expect("redqueen" in opts).toBe(false);
    });

    it("rejects grimoire: 1 as non-boolean and warns", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({ grimoire: 1 });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.grimoire");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("returns empty object for invalid JSON and warns on stderr", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = "not-json";
        expect(getCliOptions()).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain(
          "vitiate: warning: invalid VITIATE_FUZZ_OPTIONS JSON:",
        );
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("strips unknown fields from the output", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        runs: 100,
        unknownField: "hello",
      });
      const opts = getCliOptions();
      expect(opts).toEqual({ runs: 100 });
      expect("unknownField" in opts).toBe(false);
    });

    it("warns about multiple invalid fields", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          runs: "bad",
          grimoire: 42,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(2);
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe("resolveInstrumentOptions", () => {
    it("returns defaults when no options provided", () => {
      const result = resolveInstrumentOptions();
      expect(result.include).toEqual(["**/*.{js,ts,jsx,tsx,mjs,cjs,mts,cts}"]);
      expect(result.exclude).toEqual(["**/node_modules/**"]);
    });

    it("overrides exclude when provided", () => {
      const result = resolveInstrumentOptions({ exclude: [] });
      expect(result.exclude).toEqual([]);
    });

    it("overrides include when provided", () => {
      const result = resolveInstrumentOptions({ include: ["src/**/*.ts"] });
      expect(result.include).toEqual(["src/**/*.ts"]);
    });
  });

  it("COVERAGE_MAP_SIZE is 65536", () => {
    expect(COVERAGE_MAP_SIZE).toBe(65536);
  });
});
