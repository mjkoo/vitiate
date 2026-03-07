import { describe, it, expect, afterEach } from "vitest";
import {
  isFuzzingMode,
  isOptimizeMode,
  isMergeMode,
  checkModeExclusion,
  isLibfuzzerCompat,
  getCorpusOutputDir,
  getArtifactPrefix,
  getDictionaryPathEnv,
  getCliOptions,
  getFuzzTime,
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

  describe("isOptimizeMode", () => {
    const originalOptimize = process.env["VITIATE_OPTIMIZE"];

    afterEach(() => {
      if (originalOptimize === undefined) {
        delete process.env["VITIATE_OPTIMIZE"];
      } else {
        process.env["VITIATE_OPTIMIZE"] = originalOptimize;
      }
    });

    it("returns false when VITIATE_OPTIMIZE is not set", () => {
      delete process.env["VITIATE_OPTIMIZE"];
      expect(isOptimizeMode()).toBe(false);
    });

    it("returns false when VITIATE_OPTIMIZE is empty", () => {
      process.env["VITIATE_OPTIMIZE"] = "";
      expect(isOptimizeMode()).toBe(false);
    });

    it("returns false when VITIATE_OPTIMIZE is 0", () => {
      process.env["VITIATE_OPTIMIZE"] = "0";
      expect(isOptimizeMode()).toBe(false);
    });

    it("returns true when VITIATE_OPTIMIZE is 1", () => {
      process.env["VITIATE_OPTIMIZE"] = "1";
      expect(isOptimizeMode()).toBe(true);
    });
  });

  describe("isMergeMode", () => {
    const originalMerge = process.env["VITIATE_MERGE"];

    afterEach(() => {
      if (originalMerge === undefined) {
        delete process.env["VITIATE_MERGE"];
      } else {
        process.env["VITIATE_MERGE"] = originalMerge;
      }
    });

    it("returns false when VITIATE_MERGE is not set", () => {
      delete process.env["VITIATE_MERGE"];
      expect(isMergeMode()).toBe(false);
    });

    it("returns false when VITIATE_MERGE is 0", () => {
      process.env["VITIATE_MERGE"] = "0";
      expect(isMergeMode()).toBe(false);
    });

    it("returns true when VITIATE_MERGE is 1", () => {
      process.env["VITIATE_MERGE"] = "1";
      expect(isMergeMode()).toBe(true);
    });
  });

  describe("checkModeExclusion", () => {
    const originalOptimize = process.env["VITIATE_OPTIMIZE"];

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env["VITIATE_FUZZ"];
      } else {
        process.env["VITIATE_FUZZ"] = originalEnv;
      }
      if (originalOptimize === undefined) {
        delete process.env["VITIATE_OPTIMIZE"];
      } else {
        process.env["VITIATE_OPTIMIZE"] = originalOptimize;
      }
    });

    it("throws when both VITIATE_OPTIMIZE and VITIATE_FUZZ are set", () => {
      process.env["VITIATE_OPTIMIZE"] = "1";
      process.env["VITIATE_FUZZ"] = "1";
      expect(() => checkModeExclusion()).toThrow("mutually exclusive");
    });

    it("does not throw when only VITIATE_OPTIMIZE is set", () => {
      process.env["VITIATE_OPTIMIZE"] = "1";
      delete process.env["VITIATE_FUZZ"];
      expect(() => checkModeExclusion()).not.toThrow();
    });

    it("does not throw when only VITIATE_FUZZ is set", () => {
      delete process.env["VITIATE_OPTIMIZE"];
      process.env["VITIATE_FUZZ"] = "1";
      expect(() => checkModeExclusion()).not.toThrow();
    });

    it("does not throw when neither is set", () => {
      delete process.env["VITIATE_OPTIMIZE"];
      delete process.env["VITIATE_FUZZ"];
      expect(() => checkModeExclusion()).not.toThrow();
    });
  });

  describe("isLibfuzzerCompat", () => {
    const original = process.env["VITIATE_LIBFUZZER_COMPAT"];

    afterEach(() => {
      if (original === undefined) {
        delete process.env["VITIATE_LIBFUZZER_COMPAT"];
      } else {
        process.env["VITIATE_LIBFUZZER_COMPAT"] = original;
      }
    });

    it("returns false when not set", () => {
      delete process.env["VITIATE_LIBFUZZER_COMPAT"];
      expect(isLibfuzzerCompat()).toBe(false);
    });

    it("returns true when set to 1", () => {
      process.env["VITIATE_LIBFUZZER_COMPAT"] = "1";
      expect(isLibfuzzerCompat()).toBe(true);
    });

    it("returns false when set to 0", () => {
      process.env["VITIATE_LIBFUZZER_COMPAT"] = "0";
      expect(isLibfuzzerCompat()).toBe(false);
    });

    it("returns false when empty", () => {
      process.env["VITIATE_LIBFUZZER_COMPAT"] = "";
      expect(isLibfuzzerCompat()).toBe(false);
    });
  });

  describe("getCorpusOutputDir", () => {
    const original = process.env["VITIATE_CORPUS_OUTPUT_DIR"];

    afterEach(() => {
      if (original === undefined) {
        delete process.env["VITIATE_CORPUS_OUTPUT_DIR"];
      } else {
        process.env["VITIATE_CORPUS_OUTPUT_DIR"] = original;
      }
    });

    it("returns undefined when not set", () => {
      delete process.env["VITIATE_CORPUS_OUTPUT_DIR"];
      expect(getCorpusOutputDir()).toBeUndefined();
    });

    it("returns undefined when empty", () => {
      process.env["VITIATE_CORPUS_OUTPUT_DIR"] = "";
      expect(getCorpusOutputDir()).toBeUndefined();
    });

    it("returns the value when set", () => {
      process.env["VITIATE_CORPUS_OUTPUT_DIR"] = "./corpus/";
      expect(getCorpusOutputDir()).toBe("./corpus/");
    });
  });

  describe("getArtifactPrefix", () => {
    const original = process.env["VITIATE_ARTIFACT_PREFIX"];

    afterEach(() => {
      if (original === undefined) {
        delete process.env["VITIATE_ARTIFACT_PREFIX"];
      } else {
        process.env["VITIATE_ARTIFACT_PREFIX"] = original;
      }
    });

    it("returns undefined when not set", () => {
      delete process.env["VITIATE_ARTIFACT_PREFIX"];
      expect(getArtifactPrefix()).toBeUndefined();
    });

    it("returns undefined when empty", () => {
      process.env["VITIATE_ARTIFACT_PREFIX"] = "";
      expect(getArtifactPrefix()).toBeUndefined();
    });

    it("returns the value when set", () => {
      process.env["VITIATE_ARTIFACT_PREFIX"] = "./out/";
      expect(getArtifactPrefix()).toBe("./out/");
    });
  });

  describe("getDictionaryPathEnv", () => {
    const original = process.env["VITIATE_DICTIONARY_PATH"];

    afterEach(() => {
      if (original === undefined) {
        delete process.env["VITIATE_DICTIONARY_PATH"];
      } else {
        process.env["VITIATE_DICTIONARY_PATH"] = original;
      }
    });

    it("returns undefined when not set", () => {
      delete process.env["VITIATE_DICTIONARY_PATH"];
      expect(getDictionaryPathEnv()).toBeUndefined();
    });

    it("returns undefined when empty", () => {
      process.env["VITIATE_DICTIONARY_PATH"] = "";
      expect(getDictionaryPathEnv()).toBeUndefined();
    });

    it("returns the value when set", () => {
      process.env["VITIATE_DICTIONARY_PATH"] = "/path/to/dict.dict";
      expect(getDictionaryPathEnv()).toBe("/path/to/dict.dict");
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

    it("rejects non-integer numeric values and warns on stderr", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          runs: 1.5,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.runs");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("rejects maxLen: 0 because zero-length allocation is invalid", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          maxLen: 0,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.maxLen");
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

  describe("getFuzzTime", () => {
    const original = process.env["VITIATE_FUZZ_TIME"];

    afterEach(() => {
      if (original === undefined) {
        delete process.env["VITIATE_FUZZ_TIME"];
      } else {
        process.env["VITIATE_FUZZ_TIME"] = original;
      }
    });

    it("returns undefined when not set", () => {
      delete process.env["VITIATE_FUZZ_TIME"];
      expect(getFuzzTime()).toBeUndefined();
    });

    it("returns undefined when empty", () => {
      process.env["VITIATE_FUZZ_TIME"] = "";
      expect(getFuzzTime()).toBeUndefined();
    });

    it("converts seconds to milliseconds", () => {
      process.env["VITIATE_FUZZ_TIME"] = "30";
      expect(getFuzzTime()).toBe(30000);
    });

    it("accepts zero (unlimited)", () => {
      process.env["VITIATE_FUZZ_TIME"] = "0";
      expect(getFuzzTime()).toBe(0);
    });

    it("rejects negative values with warning", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_TIME"] = "-5";
        expect(getFuzzTime()).toBeUndefined();
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_TIME");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("rejects non-integer values with warning", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_TIME"] = "1.5";
        expect(getFuzzTime()).toBeUndefined();
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_TIME");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("rejects non-numeric values with warning", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_TIME"] = "abc";
        expect(getFuzzTime()).toBeUndefined();
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_TIME");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("rejects Infinity with warning", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_TIME"] = "Infinity";
        expect(getFuzzTime()).toBeUndefined();
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_TIME");
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe("getCliOptions VITIATE_FUZZ_TIME integration", () => {
    const originalOpts = process.env["VITIATE_FUZZ_OPTIONS"];
    const originalFuzzTime = process.env["VITIATE_FUZZ_TIME"];

    afterEach(() => {
      if (originalOpts === undefined) {
        delete process.env["VITIATE_FUZZ_OPTIONS"];
      } else {
        process.env["VITIATE_FUZZ_OPTIONS"] = originalOpts;
      }
      if (originalFuzzTime === undefined) {
        delete process.env["VITIATE_FUZZ_TIME"];
      } else {
        process.env["VITIATE_FUZZ_TIME"] = originalFuzzTime;
      }
    });

    it("VITIATE_FUZZ_TIME overrides VITIATE_FUZZ_OPTIONS.fuzzTimeMs", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        fuzzTimeMs: 60000,
        runs: 100,
      });
      process.env["VITIATE_FUZZ_TIME"] = "10";
      const opts = getCliOptions();
      expect(opts.fuzzTimeMs).toBe(10000);
      expect(opts.runs).toBe(100);
    });

    it("VITIATE_FUZZ_TIME works alone without VITIATE_FUZZ_OPTIONS", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      process.env["VITIATE_FUZZ_TIME"] = "30";
      const opts = getCliOptions();
      expect(opts.fuzzTimeMs).toBe(30000);
    });

    it("valid VITIATE_FUZZ_TIME applies when VITIATE_FUZZ_OPTIONS has invalid JSON", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = "not-json";
        process.env["VITIATE_FUZZ_TIME"] = "30";
        const opts = getCliOptions();
        expect(opts.fuzzTimeMs).toBe(30000);
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("invalid VITIATE_FUZZ_TIME does not clobber valid VITIATE_FUZZ_OPTIONS.fuzzTimeMs", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          fuzzTimeMs: 60000,
        });
        process.env["VITIATE_FUZZ_TIME"] = "not-a-number";
        const opts = getCliOptions();
        expect(opts.fuzzTimeMs).toBe(60000);
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_TIME");
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
