import {
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
  vi,
  type MockInstance,
} from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, parseDetectorsFlag, main } from "./cli.js";
import { getCliOptions } from "./config.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawnSync: vi.fn(original.spawnSync),
  };
});

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
    expect(result.fuzzOptions.fuzzExecs).toBe(100000);
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
    expect(result.fuzzOptions.fuzzExecs).toBe(100000);
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
        // -fork=1 is our default - no warning
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("parses -fork=0 with warning about unsupported in-process mode", () => {
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

    it("parses -jobs=4 with warning that multiple sessions are ignored", () => {
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
        expect(result.fuzzOptions.fuzzExecs).toBe(1000);
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
    expect(result.fuzzOptions.fuzzExecs).toBe(1000);
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
    expect(result.fuzzOptions.fuzzExecs).toBe(0);
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

describe("-detectors flag", () => {
  it("enables only listed detectors, disabling all others", () => {
    const result = parseArgs(
      argv("./test.ts", "-detectors=prototypePollution"),
    );
    expect(result.fuzzOptions.detectors).toEqual({
      prototypePollution: true,
      commandInjection: false,
      pathTraversal: false,
      redos: false,
      ssrf: false,
      unsafeEval: false,
    });
  });

  it("parses dotted option syntax", () => {
    const result = parseArgs(
      argv("./test.ts", "-detectors=pathTraversal.deniedPaths=/etc/passwd"),
    );
    expect(result.fuzzOptions.detectors).toEqual({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: { deniedPaths: "/etc/passwd" },
      redos: false,
      ssrf: false,
      unsafeEval: false,
    });
  });

  it("exits with error for invalid detector name", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as typeof process.exit);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      expect(() =>
        parseArgs(argv("./test.ts", "-detectors=nonexistent")),
      ).toThrow("process.exit called");
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("unknown detector"),
      );
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("returns undefined detectors when -detectors is not provided", () => {
    const result = parseArgs(argv("./test.ts"));
    expect(result.fuzzOptions.detectors).toBeUndefined();
  });
});

describe("parseDetectorsFlag", () => {
  it("enables listed detector and disables all others", () => {
    expect(parseDetectorsFlag("prototypePollution")).toEqual({
      prototypePollution: true,
      commandInjection: false,
      pathTraversal: false,
      redos: false,
      ssrf: false,
      unsafeEval: false,
    });
  });

  it("disables all when empty string", () => {
    expect(parseDetectorsFlag("")).toEqual({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: false,
      redos: false,
      ssrf: false,
      unsafeEval: false,
    });
  });

  it("parses dotted option and enables that detector", () => {
    expect(parseDetectorsFlag("pathTraversal.deniedPaths=/etc/passwd")).toEqual(
      {
        prototypePollution: false,
        commandInjection: false,
        pathTraversal: { deniedPaths: "/etc/passwd" },
        redos: false,
        ssrf: false,
        unsafeEval: false,
      },
    );
  });

  it("combined enable and option", () => {
    expect(
      parseDetectorsFlag("pathTraversal,pathTraversal.deniedPaths=/etc/passwd"),
    ).toEqual({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: { deniedPaths: "/etc/passwd" },
      redos: false,
      ssrf: false,
      unsafeEval: false,
    });
  });

  it("parses delimiter-separated value as raw string (schema coerces)", () => {
    const raw = `pathTraversal.deniedPaths=/etc/passwd${path.delimiter}/proc/self/environ`;
    expect(parseDetectorsFlag(raw)).toEqual({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: {
        deniedPaths: `/etc/passwd${path.delimiter}/proc/self/environ`,
      },
      redos: false,
      ssrf: false,
      unsafeEval: false,
    });
  });

  it("preserves raw string value (schema splits on path.delimiter)", () => {
    const input = `pathTraversal.deniedPaths=a${path.delimiter}b`;
    const result = parseDetectorsFlag(input);
    expect(result).toBeDefined();
    expect(result!.pathTraversal).toEqual({
      deniedPaths: `a${path.delimiter}b`,
    });
  });

  it("enables multiple detectors", () => {
    expect(parseDetectorsFlag("prototypePollution,commandInjection")).toEqual({
      prototypePollution: true,
      commandInjection: true,
      pathTraversal: false,
      redos: false,
      ssrf: false,
      unsafeEval: false,
    });
  });

  it("end-to-end: schema coerces CLI string to array via VITIATE_FUZZ_OPTIONS", () => {
    // Simulate: CLI produces raw string → JSON env var → getCliOptions schema coercion
    const cliResult = parseDetectorsFlag(
      `pathTraversal.deniedPaths=/etc/passwd${path.delimiter}/proc/self/environ`,
    );
    const prev = process.env["VITIATE_FUZZ_OPTIONS"];
    try {
      process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
        detectors: cliResult,
      });
      const options = getCliOptions();
      const pt = options.detectors?.pathTraversal;
      expect(pt).toBeTruthy();
      expect(typeof pt === "object" && pt !== null).toBe(true);
      if (typeof pt === "object" && pt !== null) {
        expect(pt.deniedPaths).toEqual(["/etc/passwd", "/proc/self/environ"]);
      }
    } finally {
      if (prev === undefined) {
        delete process.env["VITIATE_FUZZ_OPTIONS"];
      } else {
        process.env["VITIATE_FUZZ_OPTIONS"] = prev;
      }
    }
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
    const options = { fuzzExecs: 5000, maxLen: 2048, seed: 99 };
    process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify(options);
    const parsed = getCliOptions();
    expect(parsed.fuzzExecs).toBe(5000);
    expect(parsed.maxLen).toBe(2048);
    expect(parsed.seed).toBe(99);
  });

  it("getCliOptions returns empty object when env var is not set", () => {
    delete process.env["VITIATE_FUZZ_OPTIONS"];
    expect(getCliOptions()).toEqual({});
  });
});

function setupCliDispatchTest() {
  let savedArgv: string[];
  let savedExitCode: typeof process.exitCode;
  let exitSpy: MockInstance;

  beforeEach(() => {
    savedArgv = [...process.argv];
    savedExitCode = process.exitCode;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      process.exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
    exitSpy.mockRestore();
    vi.mocked(spawnSync).mockReset();
  });

  return { getExitSpy: () => exitSpy };
}

function mockSpawnSuccess() {
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    signal: null,
    output: [],
    pid: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
}

describe("subcommand dispatch", () => {
  setupCliDispatchTest();

  it("shows help and exits 0 when no subcommand given", async () => {
    process.argv = ["node", "vitiate"];
    const stdoutCalls: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutCalls.push(String(chunk));
        return true;
      });
    try {
      await expect(main()).rejects.toThrow("process.exit(0)");
      const output = stdoutCalls.join("");
      // All subcommands should be listed in help
      expect(output).toContain("fuzz");
      expect(output).toContain("regression");
      expect(output).toContain("optimize");
      expect(output).toContain("init");
      expect(output).toContain("libfuzzer");
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("--help shows help and exits 0", async () => {
    process.argv = ["node", "vitiate", "--help"];
    const stdoutCalls: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutCalls.push(String(chunk));
        return true;
      });
    try {
      await expect(main()).rejects.toThrow("process.exit(0)");
      const output = stdoutCalls.join("");
      expect(output).toContain("fuzz");
      expect(output).toContain("libfuzzer");
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("exits 1 for unknown subcommand", async () => {
    process.argv = ["node", "vitiate", "bogus"];
    const stderrCalls: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrCalls.push(String(chunk));
        return true;
      });
    try {
      await expect(main()).rejects.toThrow("process.exit(1)");
      const output = stderrCalls.join("");
      expect(output).toContain("bogus");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("suggests similar subcommand for typo", async () => {
    process.argv = ["node", "vitiate", "fuz"];
    const stderrCalls: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrCalls.push(String(chunk));
        return true;
      });
    try {
      await expect(main()).rejects.toThrow("process.exit(1)");
      const output = stderrCalls.join("");
      expect(output).toContain("fuz");
      // optique should suggest "fuzz"
      expect(output.toLowerCase()).toContain("fuzz");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("fuzz subcommand passes .fuzz. as a positional filter to vitest", async () => {
    process.argv = ["node", "vitiate", "fuzz", "--reporter", "verbose"];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, args] = mockSpawnSync.mock.calls[0]!;
    const argsList = args as string[];
    // Should contain "run", ".fuzz." as positional filter, and forwarded args
    expect(argsList).toContain("run");
    expect(argsList).toContain(".fuzz.");
    expect(argsList).toContain("--reporter");
    expect(argsList).toContain("verbose");
    expect(argsList).not.toContain("--include");
  });

  it("libfuzzer subcommand dispatches to libfuzzer handler", async () => {
    // Invoke with no args after "libfuzzer" so the libfuzzer parser
    // reports a missing-argument error mentioning TEST_FILE - this
    // proves main() routed to the real libfuzzer handler.
    process.argv = ["node", "vitiate", "libfuzzer"];
    const stderrCalls: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrCalls.push(String(chunk));
        return true;
      });
    const stdoutCalls: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutCalls.push(String(chunk));
        return true;
      });
    try {
      await expect(main()).rejects.toThrow("process.exit(1)");
      const output = stderrCalls.join("") + stdoutCalls.join("");
      expect(output).toContain("TEST_FILE");
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});

describe("fuzz subcommand flags", () => {
  setupCliDispatchTest();

  it("--fuzz-time sets VITIATE_FUZZ_TIME env var", async () => {
    process.argv = ["node", "vitiate", "fuzz", "--fuzz-time", "60"];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, , options] = mockSpawnSync.mock.calls[0]!;
    const env = (options as { env: Record<string, string> }).env;
    expect(env["VITIATE_FUZZ_TIME"]).toBe("60");
    expect(env["VITIATE_FUZZ"]).toBe("1");
  });

  it("--fuzz-execs sets VITIATE_FUZZ_EXECS env var", async () => {
    process.argv = ["node", "vitiate", "fuzz", "--fuzz-execs", "100000"];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, , options] = mockSpawnSync.mock.calls[0]!;
    const env = (options as { env: Record<string, string> }).env;
    expect(env["VITIATE_FUZZ_EXECS"]).toBe("100000");
  });

  it("--max-crashes sets VITIATE_MAX_CRASHES env var", async () => {
    process.argv = ["node", "vitiate", "fuzz", "--max-crashes", "5"];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, , options] = mockSpawnSync.mock.calls[0]!;
    const env = (options as { env: Record<string, string> }).env;
    expect(env["VITIATE_MAX_CRASHES"]).toBe("5");
  });

  it("CLI flag overrides environment variable", async () => {
    const prev = process.env["VITIATE_FUZZ_TIME"];
    process.env["VITIATE_FUZZ_TIME"] = "120";
    process.argv = ["node", "vitiate", "fuzz", "--fuzz-time", "60"];
    mockSpawnSuccess();
    try {
      await main();
      const mockSpawnSync = vi.mocked(spawnSync);
      expect(mockSpawnSync).toHaveBeenCalledOnce();
      const [, , options] = mockSpawnSync.mock.calls[0]!;
      const env = (options as { env: Record<string, string> }).env;
      // CLI flag should override env var
      expect(env["VITIATE_FUZZ_TIME"]).toBe("60");
    } finally {
      if (prev === undefined) {
        delete process.env["VITIATE_FUZZ_TIME"];
      } else {
        process.env["VITIATE_FUZZ_TIME"] = prev;
      }
    }
  });

  it("multiple flags combined set all env vars", async () => {
    process.argv = [
      "node",
      "vitiate",
      "fuzz",
      "--fuzz-time",
      "60",
      "--fuzz-execs",
      "100000",
      "--max-crashes",
      "3",
    ];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, , options] = mockSpawnSync.mock.calls[0]!;
    const env = (options as { env: Record<string, string> }).env;
    expect(env["VITIATE_FUZZ_TIME"]).toBe("60");
    expect(env["VITIATE_FUZZ_EXECS"]).toBe("100000");
    expect(env["VITIATE_MAX_CRASHES"]).toBe("3");
  });

  it("invalid flag value rejects with exit 1", async () => {
    process.argv = ["node", "vitiate", "fuzz", "--fuzz-time", "0"];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(main()).rejects.toThrow("process.exit(1)");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("fuzz --detectors flag", () => {
  setupCliDispatchTest();

  it("--detectors serializes to VITIATE_FUZZ_OPTIONS env var", async () => {
    process.argv = [
      "node",
      "vitiate",
      "fuzz",
      "--detectors",
      "prototypePollution,pathTraversal",
    ];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, , options] = mockSpawnSync.mock.calls[0]!;
    const env = (options as { env: Record<string, string> }).env;
    const fuzzOptions = JSON.parse(env["VITIATE_FUZZ_OPTIONS"]!);
    expect(fuzzOptions.detectors.prototypePollution).toBe(true);
    expect(fuzzOptions.detectors.pathTraversal).toBe(true);
    expect(fuzzOptions.detectors.commandInjection).toBe(false);
  });
});

describe("regression and optimize subcommand flags", () => {
  setupCliDispatchTest();

  it("regression --detectors sets VITIATE_FUZZ_OPTIONS", async () => {
    process.argv = [
      "node",
      "vitiate",
      "regression",
      "--detectors",
      "prototypePollution",
    ];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, , options] = mockSpawnSync.mock.calls[0]!;
    const env = (options as { env: Record<string, string> }).env;
    const fuzzOptions = JSON.parse(env["VITIATE_FUZZ_OPTIONS"]!);
    expect(fuzzOptions.detectors.prototypePollution).toBe(true);
    // regression should NOT set VITIATE_FUZZ or VITIATE_OPTIMIZE
    expect(env["VITIATE_FUZZ"]).toBeUndefined();
    expect(env["VITIATE_OPTIMIZE"]).toBeUndefined();
  });

  it("optimize --detectors sets VITIATE_FUZZ_OPTIONS and VITIATE_OPTIMIZE", async () => {
    process.argv = [
      "node",
      "vitiate",
      "optimize",
      "--detectors",
      "pathTraversal",
    ];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, , options] = mockSpawnSync.mock.calls[0]!;
    const env = (options as { env: Record<string, string> }).env;
    expect(env["VITIATE_OPTIMIZE"]).toBe("1");
    const fuzzOptions = JSON.parse(env["VITIATE_FUZZ_OPTIONS"]!);
    expect(fuzzOptions.detectors.pathTraversal).toBe(true);
  });

  it("regression forwards unknown flags to vitest", async () => {
    process.argv = ["node", "vitiate", "regression", "--reporter", "dot"];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, args] = mockSpawnSync.mock.calls[0]!;
    const argsList = args as string[];
    expect(argsList).toContain("--reporter");
    expect(argsList).toContain("dot");
  });
});

describe("passThrough forwarding", () => {
  setupCliDispatchTest();

  it("positional args are forwarded to vitest", async () => {
    process.argv = ["node", "vitiate", "fuzz", "test/specific.fuzz.ts"];
    mockSpawnSuccess();
    await main();
    const [, args] = vi.mocked(spawnSync).mock.calls[0]!;
    expect(args as string[]).toContain("test/specific.fuzz.ts");
  });

  it("mixed positional and option args are all forwarded", async () => {
    process.argv = [
      "node",
      "vitiate",
      "fuzz",
      "--fuzz-time",
      "60",
      "test/foo.fuzz.ts",
      "--reporter",
      "verbose",
    ];
    mockSpawnSuccess();
    await main();
    const [, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
    const argsList = args as string[];
    const env = (options as { env: Record<string, string> }).env;
    expect(env["VITIATE_FUZZ_TIME"]).toBe("60");
    expect(argsList).toContain("test/foo.fuzz.ts");
    expect(argsList).toContain("--reporter");
    expect(argsList).toContain("verbose");
    expect(argsList).not.toContain("--fuzz-time");
  });

  it("regression forwards positional args to vitest", async () => {
    process.argv = ["node", "vitiate", "regression", "test/specific.fuzz.ts"];
    mockSpawnSuccess();
    await main();
    const [, args] = vi.mocked(spawnSync).mock.calls[0]!;
    expect(args as string[]).toContain("test/specific.fuzz.ts");
  });

  it("optimize forwards positional args to vitest", async () => {
    process.argv = ["node", "vitiate", "optimize", "test/specific.fuzz.ts"];
    mockSpawnSuccess();
    await main();
    const [, args] = vi.mocked(spawnSync).mock.calls[0]!;
    expect(args as string[]).toContain("test/specific.fuzz.ts");
  });

  it("args after -- are forwarded even when they shadow vitiate flags", async () => {
    process.argv = [
      "node",
      "vitiate",
      "fuzz",
      "--fuzz-time",
      "60",
      "--",
      "--fuzz-time",
      "999",
      "--reporter",
      "verbose",
    ];
    mockSpawnSuccess();
    await main();
    const [, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
    const argsList = args as string[];
    const env = (options as { env: Record<string, string> }).env;
    expect(env["VITIATE_FUZZ_TIME"]).toBe("60");
    expect(argsList).toContain("--fuzz-time");
    expect(argsList).toContain("999");
    expect(argsList).toContain("--reporter");
  });

  it("unknown flags are forwarded to vitest", async () => {
    process.argv = [
      "node",
      "vitiate",
      "fuzz",
      "--reporter",
      "verbose",
      "--bail",
      "1",
    ];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    const [, args] = mockSpawnSync.mock.calls[0]!;
    const argsList = args as string[];
    expect(argsList).toContain("--reporter");
    expect(argsList).toContain("verbose");
    expect(argsList).toContain("--bail");
    expect(argsList).toContain("1");
  });

  it("mixed vitiate and vitest flags work", async () => {
    process.argv = [
      "node",
      "vitiate",
      "fuzz",
      "--fuzz-time",
      "60",
      "--reporter",
      "verbose",
    ];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    const [, args, options] = mockSpawnSync.mock.calls[0]!;
    const argsList = args as string[];
    const env = (options as { env: Record<string, string> }).env;
    // vitiate flag parsed as env var
    expect(env["VITIATE_FUZZ_TIME"]).toBe("60");
    // vitest flag forwarded in args
    expect(argsList).toContain("--reporter");
    expect(argsList).toContain("verbose");
    // vitiate flag should NOT be in forwarded args
    expect(argsList).not.toContain("--fuzz-time");
    expect(argsList).not.toContain("60");
  });

  it("-- separator works", async () => {
    process.argv = [
      "node",
      "vitiate",
      "fuzz",
      "--fuzz-time",
      "60",
      "--",
      "--reporter",
      "verbose",
    ];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    const [, args, options] = mockSpawnSync.mock.calls[0]!;
    const argsList = args as string[];
    const env = (options as { env: Record<string, string> }).env;
    expect(env["VITIATE_FUZZ_TIME"]).toBe("60");
    expect(argsList).toContain("--reporter");
    expect(argsList).toContain("verbose");
  });

  it("no vitiate flags forwards everything", async () => {
    process.argv = [
      "node",
      "vitiate",
      "fuzz",
      "--test-name-pattern",
      "parses URLs",
    ];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    const [, args] = mockSpawnSync.mock.calls[0]!;
    const argsList = args as string[];
    expect(argsList).toContain("--test-name-pattern");
    expect(argsList).toContain("parses URLs");
  });
});
