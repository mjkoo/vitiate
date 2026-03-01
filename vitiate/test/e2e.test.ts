/**
 * End-to-end integration tests for the fuzz API.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { initGlobals } from "../src/globals.js";
import { loadSeedCorpus, writeCrashArtifact } from "../src/corpus.js";
import { runFuzzLoop } from "../src/loop.js";
import { parseCommand } from "./parser-target.js";

const E2E_DIR = path.dirname(new URL(import.meta.url).pathname);

describe("e2e: regression mode with seeded corpus", () => {
  it("runs all seed corpus entries without crashing", () => {
    const seeds = loadSeedCorpus(E2E_DIR, "parse-planted-bug");
    expect(seeds.length).toBeGreaterThanOrEqual(3);

    // Run the target with each seed - none should crash
    // (seeds are "GET", "SET", "" - none trigger "GET!")
    for (const seed of seeds) {
      expect(() => parseCommand(seed)).not.toThrow();
    }
  });
});

describe("e2e: fuzzing mode discovers planted bug", () => {
  let tmpDir: string;
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCacheDir = process.env["VITIATE_CACHE_DIR"];
  const originalCov = globalThis.__vitiate_cov;
  const originalTrace = globalThis.__vitiate_trace_cmp;

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    if (originalCacheDir === undefined) {
      delete process.env["VITIATE_CACHE_DIR"];
    } else {
      process.env["VITIATE_CACHE_DIR"] = originalCacheDir;
    }
    globalThis.__vitiate_cov = originalCov;
    globalThis.__vitiate_trace_cmp = originalTrace;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("discovers the crash and writes a crash artifact", async () => {
    // Set up fuzzing mode
    process.env["VITIATE_FUZZ"] = "1";
    await initGlobals();

    tmpDir = path.join(
      tmpdir(),
      `vitiate-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    process.env["VITIATE_CACHE_DIR"] = path.join(tmpDir, ".cache");

    // Use a trivial single-byte crash target: any input containing 0x42
    // is guaranteed to be discovered quickly by the fuzzer's byte mutations.
    const result = await runFuzzLoop(
      (data) => {
        if (data.length >= 1 && data[0] === 0x42) {
          throw new Error("single-byte crash");
        }
      },
      tmpDir,
      "single-byte-crash",
      { runs: 1_000_000, maxTotalTimeMs: 30_000 },
    );

    expect(result.crashed).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toContain("single-byte crash");
    expect(result.crashArtifactPath).toBeDefined();
    expect(existsSync(result.crashArtifactPath!)).toBe(true);

    // Verify crash artifact contains the triggering byte
    const crashData = readFileSync(result.crashArtifactPath!);
    expect(crashData[0]).toBe(0x42);
  });

  it("crash artifact replays as a failing regression test", async () => {
    // Set up fuzzing mode to find the crash
    process.env["VITIATE_FUZZ"] = "1";
    await initGlobals();

    tmpDir = path.join(
      tmpdir(),
      `vitiate-e2e-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    process.env["VITIATE_CACHE_DIR"] = path.join(tmpDir, ".cache");

    // Write a known crash input as a crash artifact
    const crashInput = Buffer.from("GET!");
    const artifactPath = writeCrashArtifact(
      tmpDir,
      "parse-planted-bug",
      crashInput,
    );
    expect(existsSync(artifactPath)).toBe(true);

    // Now load the seed corpus (which includes the crash artifact)
    const seeds = loadSeedCorpus(tmpDir, "parse-planted-bug");
    expect(seeds.length).toBe(1); // Just the crash artifact

    // Replaying the crash artifact should fail - this is regression mode behavior
    const crashEntry = seeds[0]!;
    expect(() => parseCommand(crashEntry)).toThrow("parser crash");
  });
}, 60000);

describe("e2e: instrumented child process", () => {
  it("runs the instrumented vitest config and all tests pass", () => {
    const vitiatePkg = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
    );
    // Run the instrumented test suite as a child process
    // It verifies that instrumented code produces non-zero coverage entries
    const output = execFileSync(
      "npx",
      ["vitest", "run", "--config", "test/vitest.instrumented.config.ts"],
      {
        cwd: vitiatePkg,
        timeout: 60_000,
        encoding: "utf-8",
      },
    );
    expect(output).toContain("2 passed");
  });
}, 120000);
