import { describe, it, expect, afterEach } from "vitest";
import {
  isFuzzingMode,
  isOptimizeMode,
  isMergeMode,
  isDebugMode,
  checkModeExclusion,
  isLibfuzzerCompat,
  getCorpusOutputDir,
  getArtifactPrefix,
  getDictionaryPathEnv,
  getCorpusDirs,
  getMergeControlFile,
  getCliIpc,
  setCliIpc,
  warnUnknownVitiateEnvVars,
  getCliOptions,
  getFuzzExecs,
  getFuzzTime,
  getMaxCrashes,
  resolveInstrumentOptions,
  resolveStopOnCrash,
  COVERAGE_MAP_SIZE,
  getCoverageMapSize,
  setCoverageMapSize,
  resetCoverageMapSize,
} from "./config.js";

describe("config", () => {
  const originalEnv = process.env["VITIATE_FUZZ"];
  const originalCliIpc = process.env["VITIATE_CLI_IPC"];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalEnv;
    }
    if (originalCliIpc === undefined) {
      delete process.env["VITIATE_CLI_IPC"];
    } else {
      process.env["VITIATE_CLI_IPC"] = originalCliIpc;
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
    it("returns false when VITIATE_CLI_IPC is not set", () => {
      delete process.env["VITIATE_CLI_IPC"];
      expect(isMergeMode()).toBe(false);
    });

    it("returns false when merge is not in IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({});
      expect(isMergeMode()).toBe(false);
    });

    it("returns true when merge is true in IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({ merge: true });
      expect(isMergeMode()).toBe(true);
    });

    it("returns false when merge is false in IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({ merge: false });
      expect(isMergeMode()).toBe(false);
    });
  });

  describe("isDebugMode", () => {
    const originalDebug = process.env["VITIATE_DEBUG"];

    afterEach(() => {
      if (originalDebug === undefined) {
        delete process.env["VITIATE_DEBUG"];
      } else {
        process.env["VITIATE_DEBUG"] = originalDebug;
      }
    });

    it("returns false when VITIATE_DEBUG is not set", () => {
      delete process.env["VITIATE_DEBUG"];
      expect(isDebugMode()).toBe(false);
    });

    it("returns true when VITIATE_DEBUG is 1", () => {
      process.env["VITIATE_DEBUG"] = "1";
      expect(isDebugMode()).toBe(true);
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
    it("returns false when IPC blob is not set", () => {
      delete process.env["VITIATE_CLI_IPC"];
      expect(isLibfuzzerCompat()).toBe(false);
    });

    it("returns true when libfuzzerCompat is true in IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({
        libfuzzerCompat: true,
      });
      expect(isLibfuzzerCompat()).toBe(true);
    });

    it("returns false when libfuzzerCompat is false in IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({
        libfuzzerCompat: false,
      });
      expect(isLibfuzzerCompat()).toBe(false);
    });

    it("returns false when libfuzzerCompat is absent from IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({});
      expect(isLibfuzzerCompat()).toBe(false);
    });
  });

  describe("getCorpusOutputDir", () => {
    it("returns undefined when IPC blob is not set", () => {
      delete process.env["VITIATE_CLI_IPC"];
      expect(getCorpusOutputDir()).toBeUndefined();
    });

    it("returns undefined when corpusOutputDir is absent from IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({});
      expect(getCorpusOutputDir()).toBeUndefined();
    });

    it("returns the value when set in IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({
        corpusOutputDir: "./corpus/",
      });
      expect(getCorpusOutputDir()).toBe("./corpus/");
    });
  });

  describe("getArtifactPrefix", () => {
    it("returns undefined when IPC blob is not set", () => {
      delete process.env["VITIATE_CLI_IPC"];
      expect(getArtifactPrefix()).toBeUndefined();
    });

    it("returns undefined when artifactPrefix is absent from IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({});
      expect(getArtifactPrefix()).toBeUndefined();
    });

    it("returns the value when set in IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({
        artifactPrefix: "./out/",
      });
      expect(getArtifactPrefix()).toBe("./out/");
    });
  });

  describe("getDictionaryPathEnv", () => {
    it("returns undefined when IPC blob is not set", () => {
      delete process.env["VITIATE_CLI_IPC"];
      expect(getDictionaryPathEnv()).toBeUndefined();
    });

    it("returns undefined when dictionaryPath is absent from IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({});
      expect(getDictionaryPathEnv()).toBeUndefined();
    });

    it("returns the value when set in IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({
        dictionaryPath: "/path/to/dict.dict",
      });
      expect(getDictionaryPathEnv()).toBe("/path/to/dict.dict");
    });
  });

  describe("getCorpusDirs", () => {
    it("returns undefined when IPC blob is not set", () => {
      delete process.env["VITIATE_CLI_IPC"];
      expect(getCorpusDirs()).toBeUndefined();
    });

    it("returns undefined when corpusDirs is absent from IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({});
      expect(getCorpusDirs()).toBeUndefined();
    });

    it("returns the array when set in IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({
        corpusDirs: ["/a", "/b"],
      });
      expect(getCorpusDirs()).toEqual(["/a", "/b"]);
    });
  });

  describe("getMergeControlFile", () => {
    it("returns undefined when IPC blob is not set", () => {
      delete process.env["VITIATE_CLI_IPC"];
      expect(getMergeControlFile()).toBeUndefined();
    });

    it("returns undefined when mergeControlFile is absent from IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({});
      expect(getMergeControlFile()).toBeUndefined();
    });

    it("returns the value when set in IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({
        mergeControlFile: "/tmp/merge.jsonl",
      });
      expect(getMergeControlFile()).toBe("/tmp/merge.jsonl");
    });
  });

  describe("getCliIpc", () => {
    it("returns empty object when env var is not set", () => {
      delete process.env["VITIATE_CLI_IPC"];
      expect(getCliIpc()).toEqual({});
    });

    it("returns empty object when env var is empty", () => {
      process.env["VITIATE_CLI_IPC"] = "";
      expect(getCliIpc()).toEqual({});
    });

    it("parses valid JSON blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({
        libfuzzerCompat: true,
        merge: false,
        corpusDirs: ["/a"],
      });
      const ipc = getCliIpc();
      expect(ipc.libfuzzerCompat).toBe(true);
      expect(ipc.merge).toBe(false);
      expect(ipc.corpusDirs).toEqual(["/a"]);
    });

    it("returns empty object for invalid JSON and warns", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_CLI_IPC"] = "not-json";
        expect(getCliIpc()).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_CLI_IPC JSON");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("returns empty object for non-object JSON and warns", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_CLI_IPC"] = JSON.stringify([1, 2, 3]);
        expect(getCliIpc()).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("must be a JSON object");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("returns empty object for validation errors and warns", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_CLI_IPC"] = JSON.stringify({
          libfuzzerCompat: "not-a-boolean",
        });
        expect(getCliIpc()).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_CLI_IPC.libfuzzerCompat");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("strips unknown fields from the output", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({
        merge: true,
        unknownField: "hello",
      });
      const ipc = getCliIpc();
      expect(ipc).toEqual({ merge: true });
      expect("unknownField" in ipc).toBe(false);
    });
  });

  describe("setCliIpc", () => {
    it("round-trips through getCliIpc", () => {
      setCliIpc({
        libfuzzerCompat: true,
        corpusDirs: ["/a", "/b"],
        artifactPrefix: "./out/",
      });
      const ipc = getCliIpc();
      expect(ipc.libfuzzerCompat).toBe(true);
      expect(ipc.corpusDirs).toEqual(["/a", "/b"]);
      expect(ipc.artifactPrefix).toBe("./out/");
    });
  });

  describe("warnUnknownVitiateEnvVars", () => {
    it("warns about unknown VITIATE_ env vars", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      process.env["VITIATE_UNKNOWN_VAR"] = "1";
      try {
        warnUnknownVitiateEnvVars();
        expect(chunks.some((c) => c.includes("VITIATE_UNKNOWN_VAR"))).toBe(
          true,
        );
      } finally {
        process.stderr.write = originalWrite;
        delete process.env["VITIATE_UNKNOWN_VAR"];
      }
    });

    it("does not warn about known VITIATE_ env vars", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      const knownVars = [
        "VITIATE_FUZZ",
        "VITIATE_FUZZ_TIME",
        "VITIATE_OPTIMIZE",
        "VITIATE_SUPERVISOR",
        "VITIATE_SHMEM",
        "VITIATE_FUZZ_OPTIONS",
        "VITIATE_CLI_IPC",
        "VITIATE_RESULTS_FILE",
      ];
      const saved: Record<string, string | undefined> = {};
      for (const v of knownVars) {
        saved[v] = process.env[v];
        process.env[v] = "1";
      }

      try {
        warnUnknownVitiateEnvVars();
        const vitiateWarnings = chunks.filter((c) =>
          c.includes("unknown environment variable"),
        );
        expect(vitiateWarnings.length).toBe(0);
      } finally {
        process.stderr.write = originalWrite;
        for (const v of knownVars) {
          if (saved[v] === undefined) {
            delete process.env[v];
          } else {
            process.env[v] = saved[v];
          }
        }
      }
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
        fuzzExecs: 1000,
        maxLen: 4096,
        seed: 42,
      });
      const opts = getCliOptions();
      expect(opts.fuzzExecs).toBe(1000);
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
          fuzzExecs: "not-a-number",
          maxLen: 4096,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.fuzzExecs");
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
          fuzzExecs: -1,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.fuzzExecs");
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
          fuzzExecs: 1.5,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.fuzzExecs");
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
          fuzzExecs: 100,
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
          fuzzExecs: 100,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({ fuzzExecs: 100 });
        expect(chunks.length).toBe(0);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("omits grimoire when key is absent from input", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({ fuzzExecs: 100 });
      const opts = getCliOptions();
      expect(opts).toEqual({ fuzzExecs: 100 });
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
          fuzzExecs: 100,
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
          fuzzExecs: 100,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({ fuzzExecs: 100 });
        expect(chunks.length).toBe(0);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("omits unicode when key is absent from input", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({ fuzzExecs: 100 });
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
          fuzzExecs: 100,
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
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({ fuzzExecs: 100 });
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
        fuzzExecs: 100,
        unknownField: "hello",
      });
      const opts = getCliOptions();
      expect(opts).toEqual({ fuzzExecs: 100 });
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
          fuzzExecs: "bad",
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
        fuzzExecs: 100,
      });
      process.env["VITIATE_FUZZ_TIME"] = "10";
      const opts = getCliOptions();
      expect(opts.fuzzTimeMs).toBe(10000);
      expect(opts.fuzzExecs).toBe(100);
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

  describe("getFuzzExecs", () => {
    const original = process.env["VITIATE_FUZZ_EXECS"];

    afterEach(() => {
      if (original === undefined) {
        delete process.env["VITIATE_FUZZ_EXECS"];
      } else {
        process.env["VITIATE_FUZZ_EXECS"] = original;
      }
    });

    it("returns undefined when not set", () => {
      delete process.env["VITIATE_FUZZ_EXECS"];
      expect(getFuzzExecs()).toBeUndefined();
    });

    it("returns undefined when empty", () => {
      process.env["VITIATE_FUZZ_EXECS"] = "";
      expect(getFuzzExecs()).toBeUndefined();
    });

    it("returns plain integer (no unit conversion)", () => {
      process.env["VITIATE_FUZZ_EXECS"] = "50000";
      expect(getFuzzExecs()).toBe(50000);
    });

    it("accepts zero (unlimited)", () => {
      process.env["VITIATE_FUZZ_EXECS"] = "0";
      expect(getFuzzExecs()).toBe(0);
    });

    it("rejects negative values with warning", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_EXECS"] = "-5";
        expect(getFuzzExecs()).toBeUndefined();
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_EXECS");
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
        process.env["VITIATE_FUZZ_EXECS"] = "1.5";
        expect(getFuzzExecs()).toBeUndefined();
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_EXECS");
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
        process.env["VITIATE_FUZZ_EXECS"] = "abc";
        expect(getFuzzExecs()).toBeUndefined();
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_EXECS");
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe("getCliOptions VITIATE_FUZZ_EXECS integration", () => {
    const originalOpts = process.env["VITIATE_FUZZ_OPTIONS"];
    const originalFuzzExecs = process.env["VITIATE_FUZZ_EXECS"];

    afterEach(() => {
      if (originalOpts === undefined) {
        delete process.env["VITIATE_FUZZ_OPTIONS"];
      } else {
        process.env["VITIATE_FUZZ_OPTIONS"] = originalOpts;
      }
      if (originalFuzzExecs === undefined) {
        delete process.env["VITIATE_FUZZ_EXECS"];
      } else {
        process.env["VITIATE_FUZZ_EXECS"] = originalFuzzExecs;
      }
    });

    it("VITIATE_FUZZ_EXECS overrides VITIATE_FUZZ_OPTIONS.fuzzExecs", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        fuzzExecs: 100000,
      });
      process.env["VITIATE_FUZZ_EXECS"] = "50000";
      const opts = getCliOptions();
      expect(opts.fuzzExecs).toBe(50000);
    });

    it("VITIATE_FUZZ_EXECS works alone without VITIATE_FUZZ_OPTIONS", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      process.env["VITIATE_FUZZ_EXECS"] = "10000";
      const opts = getCliOptions();
      expect(opts.fuzzExecs).toBe(10000);
    });

    it("invalid VITIATE_FUZZ_EXECS does not clobber valid VITIATE_FUZZ_OPTIONS.fuzzExecs", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          fuzzExecs: 100000,
        });
        process.env["VITIATE_FUZZ_EXECS"] = "not-a-number";
        const opts = getCliOptions();
        expect(opts.fuzzExecs).toBe(100000);
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_EXECS");
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe("getMaxCrashes", () => {
    const original = process.env["VITIATE_MAX_CRASHES"];

    afterEach(() => {
      if (original === undefined) {
        delete process.env["VITIATE_MAX_CRASHES"];
      } else {
        process.env["VITIATE_MAX_CRASHES"] = original;
      }
    });

    it("returns undefined when not set", () => {
      delete process.env["VITIATE_MAX_CRASHES"];
      expect(getMaxCrashes()).toBeUndefined();
    });

    it("returns undefined when empty", () => {
      process.env["VITIATE_MAX_CRASHES"] = "";
      expect(getMaxCrashes()).toBeUndefined();
    });

    it("parses valid integer", () => {
      process.env["VITIATE_MAX_CRASHES"] = "50";
      expect(getMaxCrashes()).toBe(50);
    });

    it("parses 0 as 0", () => {
      process.env["VITIATE_MAX_CRASHES"] = "0";
      expect(getMaxCrashes()).toBe(0);
    });

    it("rejects negative values with warning", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_MAX_CRASHES"] = "-5";
        expect(getMaxCrashes()).toBeUndefined();
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_MAX_CRASHES");
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
        process.env["VITIATE_MAX_CRASHES"] = "1.5";
        expect(getMaxCrashes()).toBeUndefined();
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_MAX_CRASHES");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("rejects non-numeric strings with warning", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_MAX_CRASHES"] = "abc";
        expect(getMaxCrashes()).toBeUndefined();
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_MAX_CRASHES");
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
        process.env["VITIATE_MAX_CRASHES"] = "Infinity";
        expect(getMaxCrashes()).toBeUndefined();
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_MAX_CRASHES");
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe("getCliOptions VITIATE_MAX_CRASHES integration", () => {
    const originalOpts = process.env["VITIATE_FUZZ_OPTIONS"];
    const originalMaxCrashes = process.env["VITIATE_MAX_CRASHES"];

    afterEach(() => {
      if (originalOpts === undefined) {
        delete process.env["VITIATE_FUZZ_OPTIONS"];
      } else {
        process.env["VITIATE_FUZZ_OPTIONS"] = originalOpts;
      }
      if (originalMaxCrashes === undefined) {
        delete process.env["VITIATE_MAX_CRASHES"];
      } else {
        process.env["VITIATE_MAX_CRASHES"] = originalMaxCrashes;
      }
    });

    it("VITIATE_MAX_CRASHES overrides VITIATE_FUZZ_OPTIONS.maxCrashes", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        maxCrashes: 100,
      });
      process.env["VITIATE_MAX_CRASHES"] = "50";
      const opts = getCliOptions();
      expect(opts.maxCrashes).toBe(50);
    });

    it("VITIATE_MAX_CRASHES works alone without VITIATE_FUZZ_OPTIONS", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      process.env["VITIATE_MAX_CRASHES"] = "10";
      const opts = getCliOptions();
      expect(opts.maxCrashes).toBe(10);
    });

    it("valid VITIATE_MAX_CRASHES applies when VITIATE_FUZZ_OPTIONS has invalid JSON", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = "not-json";
        process.env["VITIATE_MAX_CRASHES"] = "30";
        const opts = getCliOptions();
        expect(opts.maxCrashes).toBe(30);
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("invalid VITIATE_MAX_CRASHES does not clobber valid VITIATE_FUZZ_OPTIONS.maxCrashes", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          maxCrashes: 100,
        });
        process.env["VITIATE_MAX_CRASHES"] = "not-a-number";
        const opts = getCliOptions();
        expect(opts.maxCrashes).toBe(100);
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_MAX_CRASHES");
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

  describe("getCoverageMapSize / setCoverageMapSize", () => {
    afterEach(() => {
      resetCoverageMapSize();
    });

    it("returns default COVERAGE_MAP_SIZE when not set", () => {
      expect(getCoverageMapSize()).toBe(65536);
    });

    it("returns the value set by setCoverageMapSize", () => {
      setCoverageMapSize(1024);
      expect(getCoverageMapSize()).toBe(1024);
    });

    it("accepts minimum valid size (256)", () => {
      setCoverageMapSize(256);
      expect(getCoverageMapSize()).toBe(256);
    });

    it("accepts maximum valid size (4194304)", () => {
      setCoverageMapSize(4_194_304);
      expect(getCoverageMapSize()).toBe(4_194_304);
    });

    it("throws for size below minimum", () => {
      expect(() => setCoverageMapSize(255)).toThrow(
        "coverageMapSize must be an integer in [256, 4194304]",
      );
    });

    it("throws for size above maximum", () => {
      expect(() => setCoverageMapSize(4_194_305)).toThrow(
        "coverageMapSize must be an integer in [256, 4194304]",
      );
    });

    it("throws for non-integer value", () => {
      expect(() => setCoverageMapSize(1024.5)).toThrow(
        "coverageMapSize must be an integer in [256, 4194304]",
      );
    });

    it("throws for zero", () => {
      expect(() => setCoverageMapSize(0)).toThrow(
        "coverageMapSize must be an integer in [256, 4194304]",
      );
    });

    it("throws for negative value", () => {
      expect(() => setCoverageMapSize(-1)).toThrow(
        "coverageMapSize must be an integer in [256, 4194304]",
      );
    });

    it("warns when size is not a power of two", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        setCoverageMapSize(1000);
        expect(getCoverageMapSize()).toBe(1000);
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("not a power of two");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("does not warn when size is a power of two", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        setCoverageMapSize(2048);
        expect(getCoverageMapSize()).toBe(2048);
        expect(chunks.length).toBe(0);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("resetCoverageMapSize restores default", () => {
      setCoverageMapSize(512);
      expect(getCoverageMapSize()).toBe(512);
      resetCoverageMapSize();
      expect(getCoverageMapSize()).toBe(65536);
    });
  });

  describe("stopOnCrash config field", () => {
    const originalOpts = process.env["VITIATE_FUZZ_OPTIONS"];

    afterEach(() => {
      if (originalOpts === undefined) {
        delete process.env["VITIATE_FUZZ_OPTIONS"];
      } else {
        process.env["VITIATE_FUZZ_OPTIONS"] = originalOpts;
      }
    });

    it("parses stopOnCrash: true", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        stopOnCrash: true,
      });
      expect(getCliOptions().stopOnCrash).toBe(true);
    });

    it("parses stopOnCrash: false", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        stopOnCrash: false,
      });
      expect(getCliOptions().stopOnCrash).toBe(false);
    });

    it('parses stopOnCrash: "auto"', () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        stopOnCrash: "auto",
      });
      expect(getCliOptions().stopOnCrash).toBe("auto");
    });

    it("omits stopOnCrash when absent", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({ fuzzExecs: 100 });
      const opts = getCliOptions();
      expect("stopOnCrash" in opts).toBe(false);
    });

    it("rejects invalid stopOnCrash string and warns", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          stopOnCrash: "invalid",
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.stopOnCrash");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("silently omits stopOnCrash: null", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          stopOnCrash: null,
          fuzzExecs: 100,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({ fuzzExecs: 100 });
        expect(chunks.length).toBe(0);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("round-trips through JSON serialization", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        stopOnCrash: "auto",
        maxCrashes: 50,
        fuzzExecs: 100,
      });
      const opts = getCliOptions();
      expect(opts.stopOnCrash).toBe("auto");
      expect(opts.maxCrashes).toBe(50);
      expect(opts.fuzzExecs).toBe(100);
    });
  });

  describe("maxCrashes config field", () => {
    const originalOpts = process.env["VITIATE_FUZZ_OPTIONS"];

    afterEach(() => {
      if (originalOpts === undefined) {
        delete process.env["VITIATE_FUZZ_OPTIONS"];
      } else {
        process.env["VITIATE_FUZZ_OPTIONS"] = originalOpts;
      }
    });

    it("parses maxCrashes: 0 (unlimited)", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        maxCrashes: 0,
      });
      expect(getCliOptions().maxCrashes).toBe(0);
    });

    it("parses maxCrashes: 1000", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        maxCrashes: 1000,
      });
      expect(getCliOptions().maxCrashes).toBe(1000);
    });

    it("omits maxCrashes when absent", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({ fuzzExecs: 100 });
      const opts = getCliOptions();
      expect("maxCrashes" in opts).toBe(false);
    });

    it("rejects negative maxCrashes and warns", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          maxCrashes: -1,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.maxCrashes");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("rejects non-integer maxCrashes and warns", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          maxCrashes: 1.5,
        });
        const opts = getCliOptions();
        expect(opts).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_FUZZ_OPTIONS.maxCrashes");
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe("forkExplicit in CliIpc", () => {
    it("returns undefined when forkExplicit is absent from IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({});
      expect(getCliIpc().forkExplicit).toBeUndefined();
    });

    it("returns true when forkExplicit is true in IPC blob", () => {
      process.env["VITIATE_CLI_IPC"] = JSON.stringify({
        forkExplicit: true,
      });
      expect(getCliIpc().forkExplicit).toBe(true);
    });

    it("round-trips forkExplicit through setCliIpc/getCliIpc", () => {
      setCliIpc({ forkExplicit: true });
      expect(getCliIpc().forkExplicit).toBe(true);
    });

    it("rejects non-boolean forkExplicit and warns", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_CLI_IPC"] = JSON.stringify({
          forkExplicit: "yes",
        });
        expect(getCliIpc()).toEqual({});
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain("VITIATE_CLI_IPC.forkExplicit");
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe("resolveStopOnCrash", () => {
    it("auto in vitest mode resolves to false", () => {
      expect(resolveStopOnCrash("auto", false, undefined)).toBe(false);
    });

    it("undefined in vitest mode resolves to false", () => {
      expect(resolveStopOnCrash(undefined, false, undefined)).toBe(false);
    });

    it("auto in CLI with fork resolves to false", () => {
      expect(resolveStopOnCrash("auto", true, true)).toBe(false);
    });

    it("auto in CLI without fork resolves to true", () => {
      expect(resolveStopOnCrash("auto", true, undefined)).toBe(true);
    });

    it("auto in CLI with forkExplicit=false resolves to true", () => {
      expect(resolveStopOnCrash("auto", true, false)).toBe(true);
    });

    it("explicit true passes through regardless of mode", () => {
      expect(resolveStopOnCrash(true, false, undefined)).toBe(true);
      expect(resolveStopOnCrash(true, true, true)).toBe(true);
      expect(resolveStopOnCrash(true, true, undefined)).toBe(true);
    });

    it("explicit false passes through regardless of mode", () => {
      expect(resolveStopOnCrash(false, false, undefined)).toBe(false);
      expect(resolveStopOnCrash(false, true, true)).toBe(false);
      expect(resolveStopOnCrash(false, true, undefined)).toBe(false);
    });

    it("undefined in CLI without fork resolves to true", () => {
      expect(resolveStopOnCrash(undefined, true, undefined)).toBe(true);
    });

    it("undefined in CLI with fork resolves to false", () => {
      expect(resolveStopOnCrash(undefined, true, true)).toBe(false);
    });
  });

  describe("detectors schema validation", () => {
    it("accepts boolean detector values", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        detectors: { prototypePollution: false },
      });
      const options = getCliOptions();
      expect(options.detectors?.prototypePollution).toBe(false);
    });

    it("accepts options object for pathTraversal", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        detectors: {
          pathTraversal: {
            allowedPaths: ["/var/www"],
            deniedPaths: ["/var/www/secrets"],
          },
        },
      });
      const options = getCliOptions();
      expect(options.detectors?.pathTraversal).toEqual({
        allowedPaths: ["/var/www"],
        deniedPaths: ["/var/www/secrets"],
      });
    });

    it("accepts empty detectors object (uses defaults)", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        detectors: {},
      });
      const options = getCliOptions();
      expect(options.detectors).toEqual({});
    });

    it("absent detectors key results in undefined", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({});
      const options = getCliOptions();
      expect(options.detectors).toBeUndefined();
    });

    it("warns about unknown detector keys and strips them", () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
          detectors: { futureDetector: true, prototypePollution: true },
        });
        const options = getCliOptions();
        expect(options.detectors?.prototypePollution).toBe(true);
        // futureDetector should be stripped (unknown key)
        expect(
          (options.detectors as Record<string, unknown>)?.["futureDetector"],
        ).toBeUndefined();
        // Should warn about the unknown key
        expect(
          chunks.some((c) => c.includes('unknown detector "futureDetector"')),
        ).toBe(true);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("strips nested null values from detectors config", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        detectors: { redos: null, prototypePollution: true },
      });
      const options = getCliOptions();
      expect(options.detectors?.prototypePollution).toBe(true);
      // redos: null should be stripped by recursive stripNulls
      expect(options.detectors?.redos).toBeUndefined();
    });
  });
});
