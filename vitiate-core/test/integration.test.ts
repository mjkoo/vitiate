/**
 * Integration tests for corpus loading and crash replay.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { initGlobals } from "../src/globals.js";
import {
  loadTestDataCorpus,
  writeArtifact,
  getTestDataDir,
} from "../src/corpus.js";
import { setDataDir, resetDataDir } from "../src/config.js";
import { parseCommand } from "./parser-target.js";

const TEST_RELATIVE_PATH = "test/integration.test.ts";

describe("regression mode with seeded corpus", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    setDataDir(tmpDir);
  });

  afterEach(() => {
    resetDataDir();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs all seed corpus entries without crashing", () => {
    // Create seed files in the new path structure
    const seedDir = path.join(
      getTestDataDir(TEST_RELATIVE_PATH, "parse-planted-bug"),
      "seeds",
    );
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(path.join(seedDir, "seed-get"), "GET");
    writeFileSync(path.join(seedDir, "seed-set"), "SET");
    writeFileSync(path.join(seedDir, "seed-empty"), "");

    const seeds = loadTestDataCorpus(TEST_RELATIVE_PATH, "parse-planted-bug");
    expect(seeds).toHaveLength(3);

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
    resetDataDir();
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
    setDataDir(tmpDir);

    // Write a known crash input as a crash artifact
    const crashInput = Buffer.from("GET!");
    const artifactPath = writeArtifact(
      TEST_RELATIVE_PATH,
      "parse-planted-bug",
      crashInput,
    );
    expect(existsSync(artifactPath)).toBe(true);

    // loadTestDataCorpus loads seeds + crashes + timeouts
    const corpus = loadTestDataCorpus(TEST_RELATIVE_PATH, "parse-planted-bug");
    expect(corpus.length).toBe(1); // Just the crash artifact

    // Replaying the crash artifact should fail - this is regression mode behavior
    const crashEntry = corpus[0]!;
    expect(() => parseCommand(crashEntry)).toThrow("parser crash");
  });
}, 60000);
