import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { parseArgs, waitForChild, WATCHDOG_EXIT_CODE } from "./cli.js";
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
    expect(result.fuzzOptions.maxTotalTimeMs).toBe(300000);
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

describe("waitForChild", () => {
  it("resolves with exit code 0 on normal exit", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const result = await waitForChild(child);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("resolves with exit code 1 on JS crash exit", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(1)"], {
      stdio: "ignore",
    });
    const result = await waitForChild(child);
    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
  });

  it("resolves with watchdog exit code 77", async () => {
    const child = spawn(
      process.execPath,
      ["-e", `process.exit(${WATCHDOG_EXIT_CODE})`],
      { stdio: "ignore" },
    );
    const result = await waitForChild(child);
    expect(result.code).toBe(WATCHDOG_EXIT_CODE);
    expect(result.signal).toBeNull();
  });

  // Unix signals (SIGKILL, SIGSEGV, SIGABRT) are not available on Windows.
  // On Windows, crash detection uses SEH and the supervisor observes abnormal
  // exit codes rather than signals.
  it.skipIf(process.platform === "win32")(
    "resolves with signal on SIGKILL",
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "process.kill(process.pid, 'SIGKILL')"],
        { stdio: "ignore" },
      );
      const result = await waitForChild(child);
      expect(result.code).toBeNull();
      expect(result.signal).toBe("SIGKILL");
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolves with signal on SIGSEGV",
    { timeout: 15_000 },
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "process.kill(process.pid, 'SIGSEGV')"],
        { stdio: "ignore" },
      );
      const result = await waitForChild(child);
      expect(result.code).toBeNull();
      expect(result.signal).toBe("SIGSEGV");
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolves with signal on SIGABRT",
    { timeout: 15_000 },
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "process.kill(process.pid, 'SIGABRT')"],
        { stdio: "ignore" },
      );
      const result = await waitForChild(child);
      expect(result.code).toBeNull();
      expect(result.signal).toBe("SIGABRT");
    },
  );
});

describe("waitForChild error handling", () => {
  it("rejects when child fails to spawn", async () => {
    const child = spawn("/nonexistent/binary/that/does/not/exist", [], {
      stdio: "ignore",
    });
    await expect(waitForChild(child)).rejects.toThrow();
  });
});
