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
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import { parseSync } from "@optique/core/parser";
import { main } from "./cli.js";
import { parseArgs, supervisorExitCode } from "./cli/libfuzzer.js";
import {
  parseDetectorsFlag,
  reproduceParser,
  pathsParser,
} from "./cli/parsers.js";
import {
  resolveReproduceTimeoutMs,
  DEFAULT_REPRODUCE_TIMEOUT_SECONDS,
} from "./cli/reproduce.js";
import {
  findOrphans,
  selectPruneTargets,
  deleteOrphans,
  prunePaths,
  validatePathsFlags,
  resolveOrphans,
  pathsEmptyMessage,
  promptYesNo,
} from "./cli/paths.js";
import type { TestManifestRow } from "./cli/discover.js";
import type { SupervisorResult } from "./supervisor.js";
import { getCliOptions, setDataDir, resetDataDir } from "./config.js";
import { getTestDataDir, getCorpusDir } from "./corpus.js";
import { hashTestPath } from "./nix-base32.js";

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

    it("accepts the parsed-but-ignored libFuzzer compat flags without throwing or warning", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const result = parseArgs(
          argv(
            "./test.ts",
            "-rss_limit_mb=2048",
            "-print_final_stats=1",
            "-close_fd_mask=0",
            "-reload=1",
          ),
        );
        expect(result.testFile).toBe("./test.ts");
        // These flags are ignored; at their no-op values nothing warns.
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("honors -error_exitcode into CliArgs (no warning - it is applied, not ignored)", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const result = parseArgs(argv("./test.ts", "-error_exitcode=99"));
        expect(result.errorExitcode).toBe(99);
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("honors -timeout_exitcode into CliArgs (no warning - it is applied, not ignored)", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const result = parseArgs(argv("./test.ts", "-timeout_exitcode=42"));
        expect(result.timeoutExitcode).toBe(42);
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("leaves errorExitcode/timeoutExitcode undefined when the flags are absent", () => {
      const result = parseArgs(argv("./test.ts"));
      expect(result.errorExitcode).toBeUndefined();
      expect(result.timeoutExitcode).toBeUndefined();
    });

    it("warns when -close_fd_mask is non-zero", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        parseArgs(argv("./test.ts", "-close_fd_mask=3"));
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("-close_fd_mask=3 is ignored"),
        );
      } finally {
        stderrSpy.mockRestore();
      }
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

describe("reproduce subcommand parser", () => {
  it("parses the input file positional argument", () => {
    const result = parseSync(reproduceParser, ["crash.bin"]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.subcommand).toBe("reproduce");
      expect(result.value.inputFile).toBe("crash.bin");
      expect(result.value.testName).toBeUndefined();
      expect(result.value.timeout).toBeUndefined();
    }
  });

  it("parses -test and -timeout flags", () => {
    const result = parseSync(reproduceParser, [
      "crash.bin",
      "-test=parse-url",
      "-timeout=5",
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.inputFile).toBe("crash.bin");
      expect(result.value.testName).toBe("parse-url");
      expect(result.value.timeout).toBe(5);
    }
  });

  it("requires the input file argument", () => {
    const result = parseSync(reproduceParser, []);
    expect(result.success).toBe(false);
  });
});

describe("resolveReproduceTimeoutMs", () => {
  it("defaults to the interactive replay timeout (30s) when omitted", () => {
    expect(resolveReproduceTimeoutMs(undefined)).toBe(
      DEFAULT_REPRODUCE_TIMEOUT_SECONDS * 1000,
    );
    expect(resolveReproduceTimeoutMs(undefined)).toBe(30_000);
  });

  it("converts an explicit -timeout from seconds to milliseconds", () => {
    expect(resolveReproduceTimeoutMs(5)).toBe(5000);
  });

  it("keeps 0 as 0 so the watchdog stays disabled", () => {
    expect(resolveReproduceTimeoutMs(0)).toBe(0);
  });
});

describe("paths subcommand parser", () => {
  it("defaults all flags off with no pattern", () => {
    const result = parseSync(pathsParser, []);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.subcommand).toBe("paths");
      expect(result.value.pattern).toBeUndefined();
      expect(result.value.json).toBe(false);
      expect(result.value.absolute).toBe(false);
      expect(result.value.dir).toBe(false);
      expect(result.value.orphans).toBe(false);
      expect(result.value.prune).toBe(false);
      expect(result.value.all).toBe(false);
      expect(result.value.force).toBe(false);
    }
  });

  it("parses a positional pattern and boolean flags", () => {
    const result = parseSync(pathsParser, [
      "round",
      "--json",
      "--orphans",
      "--prune",
      "--all",
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.pattern).toBe("round");
      expect(result.value.json).toBe(true);
      expect(result.value.orphans).toBe(true);
      expect(result.value.prune).toBe(true);
      expect(result.value.all).toBe(true);
    }
  });

  it("accepts the -f short form of --force", () => {
    const result = parseSync(pathsParser, ["--prune", "-f"]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.force).toBe(true);
    }
  });
});

function parsePaths(...args: string[]) {
  const result = parseSync(pathsParser, args);
  if (!result.success) {
    throw new Error(`paths parse failed: ${JSON.stringify(args)}`);
  }
  return result.value;
}

describe("validatePathsFlags", () => {
  it("accepts a plain invocation and single-mode flags", () => {
    expect(validatePathsFlags(parsePaths())).toBeNull();
    expect(validatePathsFlags(parsePaths("--json"))).toBeNull();
    expect(validatePathsFlags(parsePaths("--dir"))).toBeNull();
    expect(validatePathsFlags(parsePaths("--prune", "--all", "-f"))).toBeNull();
  });

  it("rejects --all/--force without --prune", () => {
    expect(validatePathsFlags(parsePaths("--all"))).toBe(
      "--all is only valid with --prune.",
    );
    expect(validatePathsFlags(parsePaths("-f"))).toBe(
      "--force is only valid with --prune.",
    );
  });

  it("rejects combining more than one of --dir/--json/--prune", () => {
    const msg = "--dir, --json, and --prune are mutually exclusive.";
    expect(validatePathsFlags(parsePaths("--dir", "--json"))).toBe(msg);
    expect(validatePathsFlags(parsePaths("--dir", "--prune"))).toBe(msg);
    expect(validatePathsFlags(parsePaths("--json", "--prune"))).toBe(msg);
  });
});

describe("pathsEmptyMessage", () => {
  it("distinguishes no-tests from no-match", () => {
    expect(pathsEmptyMessage()).toBe("No fuzz tests (*.fuzz.*) found.");
    expect(pathsEmptyMessage("url")).toBe('No fuzz tests match "url".');
  });
});

describe("resolveOrphans (empty-set safety gate)", () => {
  let tmpDir: string;

  function manifestRow(file: string, name: string): TestManifestRow {
    return {
      file,
      name,
      hashDir: hashTestPath(file, name),
      testDataDir: getTestDataDir(file, name),
      corpusDir: getCorpusDir(file, name),
      stats: { seeds: 0, crashes: 0, timeouts: 0, ooms: 0, corpus: 0 },
    };
  }

  beforeEach(() => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-resolve-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    setDataDir(tmpDir);
    // Seed an on-disk dir that would look orphaned against an empty manifest.
    mkdirSync(path.join(tmpDir, "corpus", hashTestPath("gone.fuzz.ts", "x")), {
      recursive: true,
    });
  });

  afterEach(() => {
    resetDataDir();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses --prune on an empty manifest and does NOT scan disk", () => {
    expect(resolveOrphans([], parsePaths("--prune"))).toEqual({
      refuse: true,
      orphans: [],
    });
  });

  it("refuses --orphans on an empty manifest", () => {
    expect(resolveOrphans([], parsePaths("--orphans"))).toEqual({
      refuse: true,
      orphans: [],
    });
  });

  it("does not report every dir as orphaned for --json on an empty manifest", () => {
    expect(resolveOrphans([], parsePaths("--json"))).toEqual({
      refuse: false,
      orphans: [],
    });
  });

  it("returns no orphans for a plain empty manifest", () => {
    expect(resolveOrphans([], parsePaths())).toEqual({
      refuse: false,
      orphans: [],
    });
  });

  it("finds orphans for a non-empty manifest with --orphans", () => {
    const known = manifestRow("a.fuzz.ts", "known");
    const { refuse, orphans } = resolveOrphans(
      [known],
      parsePaths("--orphans"),
    );
    expect(refuse).toBe(false);
    expect(orphans.map((o) => `${o.kind}/${o.hashDir}`)).toEqual([
      `corpus/${hashTestPath("gone.fuzz.ts", "x")}`,
    ]);
  });

  it("does not scan orphans when no orphan-consuming flag is set", () => {
    const known = manifestRow("a.fuzz.ts", "known");
    expect(resolveOrphans([known], parsePaths("url"))).toEqual({
      refuse: false,
      orphans: [],
    });
  });
});

describe("promptYesNo", () => {
  it("resolves true on an affirmative answer", async () => {
    const input = new PassThrough();
    const p = promptYesNo("? ", input, new PassThrough());
    input.write("y\n");
    expect(await p).toBe(true);
  });

  it("resolves false on a negative answer", async () => {
    const input = new PassThrough();
    const p = promptYesNo("? ", input, new PassThrough());
    input.write("n\n");
    expect(await p).toBe(false);
  });

  it("resolves false on EOF (closed stdin) without hanging", async () => {
    const input = new PassThrough();
    const p = promptYesNo("? ", input, new PassThrough());
    input.end(); // EOF with no answer
    expect(await p).toBe(false);
  });
});

describe("paths orphan detection and prune", () => {
  let tmpDir: string;

  function manifestRow(file: string, name: string): TestManifestRow {
    return {
      file,
      name,
      hashDir: hashTestPath(file, name),
      testDataDir: getTestDataDir(file, name),
      corpusDir: getCorpusDir(file, name),
      stats: { seeds: 0, crashes: 0, timeouts: 0, ooms: 0, corpus: 0 },
    };
  }

  /**
   * Create a hash dir on disk under testdata/ or corpus/ with one entry.
   * testdata entries go in the seeds bucket (where counts are tallied);
   * corpus entries live directly under the dir. Returns the hash dir path.
   */
  function seedDir(kind: "testdata" | "corpus", hashDir: string): string {
    const dir = path.join(tmpDir, kind, hashDir);
    const entryDir = kind === "testdata" ? path.join(dir, "seeds") : dir;
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(path.join(entryDir, "entry"), "x");
    return dir;
  }

  beforeEach(() => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-paths-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    setDataDir(tmpDir);
  });

  afterEach(() => {
    resetDataDir();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports on-disk dirs with no matching test as orphans", () => {
    const known = manifestRow("a.fuzz.ts", "known");
    seedDir("testdata", known.hashDir); // matches a test -> not orphan
    const staleTestData = hashTestPath("gone.fuzz.ts", "removed");
    const staleCorpus = hashTestPath("gone.fuzz.ts", "removed2");
    seedDir("testdata", staleTestData);
    seedDir("corpus", staleCorpus);

    const orphans = findOrphans([known]);
    const keys = orphans.map((o) => `${o.kind}/${o.hashDir}`).sort();
    expect(keys).toEqual([
      `corpus/${staleCorpus}`,
      `testdata/${staleTestData}`,
    ]);
    expect(orphans.every((o) => o.entries === 1)).toBe(true);
  });

  it("selects only corpus orphans unless --all is set", () => {
    const orphans = findOrphans([]); // no known tests
    seedDir("testdata", hashTestPath("x.fuzz.ts", "t"));
    seedDir("corpus", hashTestPath("x.fuzz.ts", "c"));
    const all = findOrphans([]);

    expect(selectPruneTargets(all, false).map((o) => o.kind)).toEqual([
      "corpus",
    ]);
    expect(
      selectPruneTargets(all, true)
        .map((o) => o.kind)
        .sort(),
    ).toEqual(["corpus", "testdata"]);
    expect(orphans).toEqual([]); // sanity: computed before seeding
  });

  it("deleteOrphans removes exactly the given dirs", () => {
    const a = seedDir("corpus", hashTestPath("x.fuzz.ts", "a"));
    const b = seedDir("testdata", hashTestPath("x.fuzz.ts", "b"));
    const orphans = findOrphans([]);
    deleteOrphans(orphans.filter((o) => o.path === a));
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
  });

  describe("prunePaths confirmation gate", () => {
    let stdoutSpy: MockInstance;
    let stderrSpy: MockInstance;
    let ttyDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
      stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      process.exitCode = undefined;
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      if (ttyDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      process.exitCode = undefined;
    });

    function setTTY(value: boolean): void {
      Object.defineProperty(process.stdin, "isTTY", {
        value,
        configurable: true,
      });
    }

    it("deletes without prompting when force is set", async () => {
      const dir = seedDir("corpus", hashTestPath("x.fuzz.ts", "a"));
      const orphans = findOrphans([]);
      const confirm = vi.fn<(q: string) => Promise<boolean>>();
      await prunePaths(orphans, false, true, confirm);
      expect(confirm).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(false);
    });

    it("aborts without deleting when non-TTY and not forced", async () => {
      const dir = seedDir("corpus", hashTestPath("x.fuzz.ts", "a"));
      const orphans = findOrphans([]);
      setTTY(false);
      const confirm = vi.fn<(q: string) => Promise<boolean>>();
      await prunePaths(orphans, false, false, confirm);
      expect(confirm).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(existsSync(dir)).toBe(true);
    });

    it("aborts when the user answers no", async () => {
      const dir = seedDir("corpus", hashTestPath("x.fuzz.ts", "a"));
      const orphans = findOrphans([]);
      setTTY(true);
      const confirm = vi.fn<(q: string) => Promise<boolean>>(async () => false);
      await prunePaths(orphans, false, false, confirm);
      expect(confirm).toHaveBeenCalledOnce();
      expect(existsSync(dir)).toBe(true);
    });

    it("deletes when the user answers yes", async () => {
      const dir = seedDir("corpus", hashTestPath("x.fuzz.ts", "a"));
      const orphans = findOrphans([]);
      setTTY(true);
      const confirm = vi.fn<(q: string) => Promise<boolean>>(async () => true);
      await prunePaths(orphans, false, false, confirm);
      expect(confirm).toHaveBeenCalledOnce();
      expect(existsSync(dir)).toBe(false);
    });

    it("leaves testdata orphans intact unless --all", async () => {
      const corpusDir = seedDir("corpus", hashTestPath("x.fuzz.ts", "a"));
      const testDataDir = seedDir("testdata", hashTestPath("x.fuzz.ts", "b"));
      const orphans = findOrphans([]);
      await prunePaths(orphans, false, true, vi.fn());
      expect(existsSync(corpusDir)).toBe(false);
      expect(existsSync(testDataDir)).toBe(true);
    });

    it("deletes testdata orphans when --all is set", async () => {
      const testDataDir = seedDir("testdata", hashTestPath("x.fuzz.ts", "b"));
      const orphans = findOrphans([]);
      await prunePaths(orphans, true, true, vi.fn());
      expect(existsSync(testDataDir)).toBe(false);
    });

    it("prints a Removed line per target before the summary (audit trail)", async () => {
      const a = seedDir("corpus", hashTestPath("x.fuzz.ts", "a"));
      const b = seedDir("corpus", hashTestPath("x.fuzz.ts", "b"));
      const orphans = findOrphans([]);
      await prunePaths(orphans, false, true, vi.fn());

      const lines = stdoutSpy.mock.calls.map((c) => String(c[0]));
      const removedIdx = orphans.map((o) =>
        lines.findIndex((l) => l.includes(`Removed ${o.path}`)),
      );
      const summaryIdx = lines.findIndex((l) => l.startsWith("Pruned "));
      // Every target has a Removed line, and all precede the summary.
      expect(removedIdx.every((i) => i >= 0)).toBe(true);
      expect(Math.max(...removedIdx)).toBeLessThan(summaryIdx);
      expect(existsSync(a)).toBe(false);
      expect(existsSync(b)).toBe(false);
    });
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

  it("-runs=0 maps to replay-only mode (not unlimited)", () => {
    // libFuzzer semantics: an explicit -runs=0 replays the corpus once and
    // exits, so fuzzExecs stays unset and replayOnly is signalled instead.
    const result = parseArgs(argv("./test.ts", "-runs=0"));
    expect(result.fuzzOptions.fuzzExecs).toBeUndefined();
    expect(result.fuzzOptions.replayOnly).toBe(true);
  });

  it("-runs omitted leaves fuzzExecs and replayOnly unset (unlimited)", () => {
    const result = parseArgs(argv("./test.ts"));
    expect(result.fuzzOptions.fuzzExecs).toBeUndefined();
    expect(result.fuzzOptions.replayOnly).toBeUndefined();
  });

  it("-runs=100 sets fuzzExecs and leaves replayOnly unset", () => {
    const result = parseArgs(argv("./test.ts", "-runs=100"));
    expect(result.fuzzOptions.fuzzExecs).toBe(100);
    expect(result.fuzzOptions.replayOnly).toBeUndefined();
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

  it("end-to-end: schema coerces CLI string to array via VITIATE_OPTIONS", () => {
    // Simulate: CLI produces raw string → JSON env var → getCliOptions schema coercion
    const cliResult = parseDetectorsFlag(
      `pathTraversal.deniedPaths=/etc/passwd${path.delimiter}/proc/self/environ`,
    );
    const prev = process.env["VITIATE_OPTIONS"];
    try {
      process.env["VITIATE_OPTIONS"] = JSON.stringify({
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
        delete process.env["VITIATE_OPTIONS"];
      } else {
        process.env["VITIATE_OPTIONS"] = prev;
      }
    }
  });
});

describe("CLI env var forwarding", () => {
  const originalOpts = process.env["VITIATE_OPTIONS"];

  afterEach(() => {
    if (originalOpts === undefined) {
      delete process.env["VITIATE_OPTIONS"];
    } else {
      process.env["VITIATE_OPTIONS"] = originalOpts;
    }
  });

  it("getCliOptions round-trips through VITIATE_OPTIONS", () => {
    const options = { fuzzExecs: 5000, maxLen: 2048, seed: 99 };
    process.env["VITIATE_OPTIONS"] = JSON.stringify(options);
    const parsed = getCliOptions();
    expect(parsed.fuzzExecs).toBe(5000);
    expect(parsed.maxLen).toBe(2048);
    expect(parsed.seed).toBe(99);
  });

  it("getCliOptions returns empty object when env var is not set", () => {
    delete process.env["VITIATE_OPTIONS"];
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

  it("--detectors serializes to VITIATE_OPTIONS env var", async () => {
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
    const fuzzOptions = JSON.parse(env["VITIATE_OPTIONS"]!);
    expect(fuzzOptions.detectors.prototypePollution).toBe(true);
    expect(fuzzOptions.detectors.pathTraversal).toBe(true);
    expect(fuzzOptions.detectors.commandInjection).toBe(false);
  });
});

describe("regression and optimize subcommand flags", () => {
  setupCliDispatchTest();

  it("regression --detectors sets VITIATE_OPTIONS", async () => {
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
    const fuzzOptions = JSON.parse(env["VITIATE_OPTIONS"]!);
    expect(fuzzOptions.detectors.prototypePollution).toBe(true);
    // regression should NOT set VITIATE_FUZZ or VITIATE_OPTIMIZE
    expect(env["VITIATE_FUZZ"]).toBeUndefined();
    expect(env["VITIATE_OPTIMIZE"]).toBeUndefined();
  });

  it("optimize --detectors sets VITIATE_OPTIONS and VITIATE_OPTIMIZE", async () => {
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
    const fuzzOptions = JSON.parse(env["VITIATE_OPTIONS"]!);
    expect(fuzzOptions.detectors.pathTraversal).toBe(true);
  });

  it("optimize --timeout sets VITIATE_OPTIONS.timeoutMs in milliseconds", async () => {
    process.argv = ["node", "vitiate", "optimize", "--timeout", "5"];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, , options] = mockSpawnSync.mock.calls[0]!;
    const env = (options as { env: Record<string, string> }).env;
    expect(env["VITIATE_OPTIMIZE"]).toBe("1");
    const fuzzOptions = JSON.parse(env["VITIATE_OPTIONS"]!);
    // CLI seconds are converted to internal milliseconds.
    expect(fuzzOptions.timeoutMs).toBe(5000);
  });

  it("optimize pins --pool=forks so the replay watchdog can arm", async () => {
    process.argv = ["node", "vitiate", "optimize"];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, args] = mockSpawnSync.mock.calls[0]!;
    expect(args as string[]).toContain("--pool=forks");
  });

  it("optimize does not add --pool=forks when the user passes --pool", async () => {
    // vitest's CLI rejects a repeated --pool, so an explicit user pool must
    // suppress the pin rather than be overridden by it.
    process.argv = ["node", "vitiate", "optimize", "--pool=threads"];
    mockSpawnSuccess();
    await main();
    const mockSpawnSync = vi.mocked(spawnSync);
    expect(mockSpawnSync).toHaveBeenCalledOnce();
    const [, args] = mockSpawnSync.mock.calls[0]!;
    const argsList = args as string[];
    expect(argsList).toContain("--pool=threads");
    expect(argsList).not.toContain("--pool=forks");
  });

  it("optimize --timeout 0 disables the watchdog (timeoutMs 0)", async () => {
    process.argv = ["node", "vitiate", "optimize", "--timeout", "0"];
    mockSpawnSuccess();
    await main();
    const [, , options] = vi.mocked(spawnSync).mock.calls[0]!;
    const env = (options as { env: Record<string, string> }).env;
    const fuzzOptions = JSON.parse(env["VITIATE_OPTIONS"]!);
    expect(fuzzOptions.timeoutMs).toBe(0);
  });

  it("optimize combines --timeout and --detectors in one VITIATE_OPTIONS", async () => {
    process.argv = [
      "node",
      "vitiate",
      "optimize",
      "--timeout",
      "3",
      "--detectors",
      "pathTraversal",
    ];
    mockSpawnSuccess();
    await main();
    const [, , options] = vi.mocked(spawnSync).mock.calls[0]!;
    const env = (options as { env: Record<string, string> }).env;
    const fuzzOptions = JSON.parse(env["VITIATE_OPTIONS"]!);
    expect(fuzzOptions.timeoutMs).toBe(3000);
    expect(fuzzOptions.detectors.pathTraversal).toBe(true);
  });

  it("optimize without --timeout omits timeoutMs", async () => {
    process.argv = ["node", "vitiate", "optimize"];
    mockSpawnSuccess();
    await main();
    const [, , options] = vi.mocked(spawnSync).mock.calls[0]!;
    const env = (options as { env: Record<string, string> }).env;
    // No options flags -> VITIATE_OPTIONS is not set at all.
    expect(env["VITIATE_OPTIONS"]).toBeUndefined();
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

describe("supervisorExitCode", () => {
  it("maps a clean exit to 0", () => {
    expect(supervisorExitCode({ crashed: false, exitCode: 0 })).toBe(0);
  });

  it("maps a found crash to libFuzzer's error_exitcode (77)", () => {
    expect(supervisorExitCode({ crashed: true, signal: "SIGSEGV" })).toBe(77);
    expect(supervisorExitCode({ crashed: true, exitCode: 134 })).toBe(77);
  });

  it("maps a timeout finding to libFuzzer's timeout_exitcode (70)", () => {
    // A timeout sets both timedOut and crashed; timedOut wins.
    expect(
      supervisorExitCode({ crashed: true, timedOut: true, exitCode: 1 }),
    ).toBe(70);
  });

  it("honors -error_exitcode override for a crash", () => {
    expect(
      supervisorExitCode({ crashed: true, exitCode: 1 }, { errorExitcode: 99 }),
    ).toBe(99);
  });

  it("honors -timeout_exitcode override for a timeout", () => {
    expect(
      supervisorExitCode(
        { crashed: true, timedOut: true, exitCode: 1 },
        { timeoutExitcode: 5 },
      ),
    ).toBe(5);
  });

  it("maps an OOM via exit code 137 to 137", () => {
    expect(
      supervisorExitCode({ crashed: false, oomKilled: true, exitCode: 137 }),
    ).toBe(137);
  });

  it("maps an OOM via SIGKILL signal (no exit code) to 137", () => {
    // Regression guard: the signal form leaves exitCode undefined, which must
    // NOT fall through to `exitCode ?? 0` and report success.
    expect(
      supervisorExitCode({
        crashed: false,
        oomKilled: true,
        signal: "SIGKILL",
      }),
    ).toBe(137);
  });

  it("maps a startup failure to the child's non-zero exit code", () => {
    expect(
      supervisorExitCode({
        crashed: false,
        startupFailure: true,
        exitCode: 134,
      }),
    ).toBe(134);
  });

  it("maps a startup failure with no exit code (signal death) to 1", () => {
    expect(
      supervisorExitCode({
        crashed: false,
        startupFailure: true,
        signal: "SIGSEGV",
      }),
    ).toBe(1);
  });

  it("maps an engine panic to its reserved exit code (78)", () => {
    expect(
      supervisorExitCode({ crashed: false, engineError: true, exitCode: 78 }),
    ).toBe(78);
  });

  it("prefers timeout (70) over crash when both timedOut and crashed are set", () => {
    // timedOut is checked first; a timeout carries crashed:true too.
    const result: SupervisorResult = {
      crashed: true,
      timedOut: true,
      exitCode: 1,
    };
    expect(supervisorExitCode(result)).toBe(70);
  });
});
