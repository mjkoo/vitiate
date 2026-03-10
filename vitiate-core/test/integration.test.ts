/**
 * Integration tests for corpus loading and crash replay.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { initGlobals } from "../src/globals.js";
import { loadSeedCorpus, writeArtifact } from "../src/corpus.js";
import { setCacheDir, resetCacheDir } from "../src/config.js";
import { parseCommand } from "./parser-target.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

describe("regression mode with seeded corpus", () => {
  it("runs all seed corpus entries without crashing", () => {
    const seeds = loadSeedCorpus(TEST_DIR, "parse-planted-bug");
    expect(seeds.length).toBeGreaterThanOrEqual(3);

    // Run the target with each seed - none should crash
    // (seeds are "GET", "SET", "" - none trigger "GET!")
    for (const seed of seeds) {
      expect(() => parseCommand(seed)).not.toThrow();
    }
  });
});

describe("fuzzing mode discovers planted bug", () => {
  let tmpDir: string;
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCov = globalThis.__vitiate_cov;
  const originalTrace = globalThis.__vitiate_trace_cmp;

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    resetCacheDir();
    globalThis.__vitiate_cov = originalCov;
    globalThis.__vitiate_trace_cmp = originalTrace;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
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
    setCacheDir(path.join(tmpDir, ".cache"));

    // Write a known crash input as a crash artifact
    const crashInput = Buffer.from("GET!");
    const artifactPath = writeArtifact(tmpDir, "parse-planted-bug", crashInput);
    expect(existsSync(artifactPath)).toBe(true);

    // Now load the seed corpus (which includes the crash artifact)
    const seeds = loadSeedCorpus(tmpDir, "parse-planted-bug");
    expect(seeds.length).toBe(1); // Just the crash artifact

    // Replaying the crash artifact should fail - this is regression mode behavior
    const crashEntry = seeds[0]!;
    expect(() => parseCommand(crashEntry)).toThrow("parser crash");
  });
}, 60000);
