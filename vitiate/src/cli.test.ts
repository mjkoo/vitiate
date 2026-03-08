import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "./cli.js";
import { getCliOptions } from "./config.js";

function argv(...args: string[]): string[] {
  return ["node", "vitiate", ...args];
}

describe("parseArgs", () => {
  it("parses test file from first positional argument", () => {
    const result = parseArgs(argv("./test.ts"));
    expect(result.testFile).toBe("./test.ts");
  });

  it("throws when no arguments given", () => {
    expect(() => parseArgs(argv())).toThrow();
  });

  it("parses -max_len flag", () => {
    const result = parseArgs(argv("./test.ts", "-max_len=1024"));
    expect(result.fuzzOptions.maxLen).toBe(1024);
  });

  it("parses -timeout flag (converts seconds to ms)", () => {
    const result = parseArgs(argv("./test.ts", "-timeout=10"));
    expect(result.fuzzOptions.timeoutMs).toBe(10000);
  });

  it("parses -runs flag", () => {
    const result = parseArgs(argv("./test.ts", "-runs=100000"));
    expect(result.fuzzOptions.runs).toBe(100000);
  });

  it("parses -seed flag", () => {
    const result = parseArgs(argv("./test.ts", "-seed=42"));
    expect(result.fuzzOptions.seed).toBe(42);
  });

  it("parses -max_total_time flag (converts seconds to ms)", () => {
    const result = parseArgs(argv("./test.ts", "-max_total_time=300"));
    expect(result.fuzzOptions.fuzzTimeMs).toBe(300000);
  });

  it("parses multiple flags together", () => {
    const result = parseArgs(
      argv("./test.ts", "-timeout=10", "-runs=100000", "-seed=42"),
    );
    expect(result.fuzzOptions.timeoutMs).toBe(10000);
    expect(result.fuzzOptions.runs).toBe(100000);
    expect(result.fuzzOptions.seed).toBe(42);
  });

  it("throws on unknown flags", () => {
    expect(() => parseArgs(argv("./test.ts", "-unknown=1"))).toThrow();
  });

  it("parses corpus directories as additional positional args", () => {
    const result = parseArgs(argv("./test.ts", "./corpus/", "./seeds/"));
    expect(result.testFile).toBe("./test.ts");
    expect(result.corpusDirs).toEqual(["./corpus/", "./seeds/"]);
  });

  describe("libFuzzer-compatible flags (-fork, -jobs, -merge)", () => {
    it("parses -fork=1 without warning (matches default architecture)", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const result = parseArgs(argv("./test.ts", "-fork=1"));
        expect(result.testFile).toBe("./test.ts");
        // -fork=1 is our default — no warning
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("parses -fork=0 with warning about unsupported non-fork mode", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const result = parseArgs(argv("./test.ts", "-fork=0"));
        expect(result.testFile).toBe("./test.ts");
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("-fork=0"),
        );
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("parses -fork=4 with warning that multi-worker mode is ignored", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const result = parseArgs(argv("./test.ts", "-fork=4"));
        expect(result.testFile).toBe("./test.ts");
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("-fork=4 is ignored"),
        );
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("parses -jobs=1 without warning (matches default architecture)", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const result = parseArgs(argv("./test.ts", "-jobs=1"));
        expect(result.testFile).toBe("./test.ts");
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("parses -jobs=4 with warning that parallel jobs are ignored", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        parseArgs(argv("./test.ts", "-jobs=4"));
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("-jobs=4 is ignored"),
        );
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("parses -merge=1 and sets merge flag", () => {
      const result = parseArgs(argv("./test.ts", "-merge=1"));
      expect(result.merge).toBe(true);
    });

    it("parses -merge=0 without merge mode", () => {
      const result = parseArgs(argv("./test.ts", "-merge=0"));
      expect(result.merge).toBe(false);
    });

    it("unknown flags still cause parse errors", () => {
      expect(() => parseArgs(argv("./test.ts", "-bogus=1"))).toThrow();
    });

    it("combines libFuzzer flags with supported flags", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const result = parseArgs(
          argv("./test.ts", "-fork=1", "-runs=1000", "-timeout=5"),
        );
        expect(result.fuzzOptions.runs).toBe(1000);
        expect(result.fuzzOptions.timeoutMs).toBe(5000);
        // -fork=1 is default, no warning
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});

describe("-artifact_prefix flag", () => {
  it("parses -artifact_prefix flag with directory prefix", () => {
    const result = parseArgs(argv("./test.ts", "-artifact_prefix=./out/"));
    expect(result.artifactPrefix).toBe("./out/");
  });

  it("parses -artifact_prefix flag with non-directory prefix", () => {
    const result = parseArgs(argv("./test.ts", "-artifact_prefix=bug-"));
    expect(result.artifactPrefix).toBe("bug-");
  });

  it("returns undefined artifactPrefix when not provided", () => {
    const result = parseArgs(argv("./test.ts"));
    expect(result.artifactPrefix).toBeUndefined();
  });

  it("combines -artifact_prefix with other flags", () => {
    const result = parseArgs(
      argv("./test.ts", "-artifact_prefix=./out/", "-timeout=10", "-runs=1000"),
    );
    expect(result.artifactPrefix).toBe("./out/");
    expect(result.fuzzOptions.timeoutMs).toBe(10000);
    expect(result.fuzzOptions.runs).toBe(1000);
  });
});

describe("-test flag", () => {
  it("parses -test flag", () => {
    const result = parseArgs(argv("./test.ts", "-test=parse-url"));
    expect(result.testName).toBe("parse-url");
  });

  it("returns undefined testName when not provided", () => {
    const result = parseArgs(argv("./test.ts"));
    expect(result.testName).toBeUndefined();
  });

  it("combines -test with other flags", () => {
    const result = parseArgs(
      argv(
        "./test.ts",
        "-test=parse-url",
        "-max_total_time=30",
        "-max_len=4096",
      ),
    );
    expect(result.testName).toBe("parse-url");
    expect(result.fuzzOptions.fuzzTimeMs).toBe(30000);
    expect(result.fuzzOptions.maxLen).toBe(4096);
  });
});

describe("minimization config flags", () => {
  it("parses -minimize_budget flag", () => {
    const result = parseArgs(argv("./test.ts", "-minimize_budget=5000"));
    expect(result.fuzzOptions.minimizeBudget).toBe(5000);
  });

  it("parses -minimize_time_limit flag (converts seconds to ms)", () => {
    const result = parseArgs(argv("./test.ts", "-minimize_time_limit=10"));
    expect(result.fuzzOptions.minimizeTimeLimitMs).toBe(10000);
  });

  it("defaults to undefined when not specified", () => {
    const result = parseArgs(argv("./test.ts"));
    expect(result.fuzzOptions.minimizeBudget).toBeUndefined();
    expect(result.fuzzOptions.minimizeTimeLimitMs).toBeUndefined();
  });
});

describe("zero-value CLI flags (0 = unlimited convention)", () => {
  it("-timeout=0 converts to timeoutMs: 0", () => {
    const result = parseArgs(argv("./test.ts", "-timeout=0"));
    expect(result.fuzzOptions.timeoutMs).toBe(0);
  });

  it("-runs=0 converts to runs: 0", () => {
    const result = parseArgs(argv("./test.ts", "-runs=0"));
    expect(result.fuzzOptions.runs).toBe(0);
  });

  it("-max_total_time=0 converts to fuzzTimeMs: 0", () => {
    const result = parseArgs(argv("./test.ts", "-max_total_time=0"));
    expect(result.fuzzOptions.fuzzTimeMs).toBe(0);
  });

  it("-minimize_time_limit=0 converts to minimizeTimeLimitMs: 0", () => {
    const result = parseArgs(argv("./test.ts", "-minimize_time_limit=0"));
    expect(result.fuzzOptions.minimizeTimeLimitMs).toBe(0);
  });

  it("-minimize_budget=0 converts to minimizeBudget: 0", () => {
    const result = parseArgs(argv("./test.ts", "-minimize_budget=0"));
    expect(result.fuzzOptions.minimizeBudget).toBe(0);
  });
});

describe("-dict flag", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses -dict flag and resolves to absolute path", () => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-dict-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    const dictPath = path.join(tmpDir, "test.dict");
    writeFileSync(dictPath, '"keyword"\n');

    const result = parseArgs(argv("./test.ts", `-dict=${dictPath}`));
    expect(result.dictPath).toBe(dictPath);
  });

  it("exits with error for nonexistent dictionary file", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as typeof process.exit);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      expect(() =>
        parseArgs(argv("./test.ts", "-dict=/nonexistent/dict.dict")),
      ).toThrow("process.exit called");
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("dictionary file not found"),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("returns undefined dictPath when -dict is not provided", () => {
    const result = parseArgs(argv("./test.ts"));
    expect(result.dictPath).toBeUndefined();
  });
});

describe("forkExplicit in CliArgs", () => {
  it("sets forkExplicit when -fork flag is present", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const result = parseArgs(argv("./test.ts", "-fork=1"));
      expect(result.forkExplicit).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("sets forkExplicit when -fork=0 is present", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const result = parseArgs(argv("./test.ts", "-fork=0"));
      expect(result.forkExplicit).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("leaves forkExplicit undefined when -fork is absent", () => {
    const result = parseArgs(argv("./test.ts"));
    expect(result.forkExplicit).toBeUndefined();
  });
});

describe("CLI env var forwarding", () => {
  const originalOpts = process.env["VITIATE_FUZZ_OPTIONS"];

  afterEach(() => {
    if (originalOpts === undefined) {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
    } else {
      process.env["VITIATE_FUZZ_OPTIONS"] = originalOpts;
    }
  });

  it("getCliOptions round-trips through VITIATE_FUZZ_OPTIONS", () => {
    const options = { runs: 5000, maxLen: 2048, seed: 99 };
    process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify(options);
    const parsed = getCliOptions();
    expect(parsed.runs).toBe(5000);
    expect(parsed.maxLen).toBe(2048);
    expect(parsed.seed).toBe(99);
  });

  it("getCliOptions returns empty object when env var is not set", () => {
    delete process.env["VITIATE_FUZZ_OPTIONS"];
    expect(getCliOptions()).toEqual({});
  });
});
