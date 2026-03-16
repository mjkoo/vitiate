import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createReporter,
  startReporting,
  stopReporting,
  reportStatus,
  printCrash,
  printSummary,
  writeResultsFile,
} from "./reporter.js";
import type { ResultsFileContent } from "./reporter.js";
import type { FuzzerStats } from "@vitiate/engine";

describe("reporter", () => {
  let stderrSpy: MockInstance;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("reportStatus writes a status line to stderr", () => {
    const state = createReporter(false);
    const stats: FuzzerStats = {
      totalExecs: 50000,
      calibrationExecs: 300,
      corpusSize: 100,
      solutionCount: 0,
      coverageEdges: 500,
      coverageFeatures: 750,
      execsPerSec: 25000,
    };

    reportStatus(state, stats);

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toContain("elapsed:");
    expect(output).toContain("execs: 50000");
    expect(output).toContain("25000/sec");
    expect(output).toContain("cal: 300");
    expect(output).toContain("corpus: 100");
    expect(output).toContain("edges: 500");
    expect(output).toContain("ft: 750");
  });

  it("printCrash writes crash info to stderr", () => {
    const error = new Error("test crash");
    printCrash(error, "/path/to/crash-abc123");

    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(output).toContain("CRASH FOUND");
    expect(output).toContain("test crash");
    expect(output).toContain("/path/to/crash-abc123");
  });

  it("printSummary writes final summary to stderr", () => {
    const state = createReporter(false);
    const stats: FuzzerStats = {
      totalExecs: 100000,
      calibrationExecs: 600,
      corpusSize: 200,
      solutionCount: 1,
      coverageEdges: 800,
      coverageFeatures: 1200,
      execsPerSec: 50000,
    };

    printSummary(state, stats);

    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(output).toContain("done");
    expect(output).toContain("execs: 100000");
    expect(output).toContain("cal: 600");
    expect(output).toContain("corpus: 200");
    expect(output).toContain("edges: 800");
    expect(output).toContain("ft: 1200");
  });

  it("printSummary includes dedup skipped count when > 0", () => {
    const state = createReporter(false);
    const stats: FuzzerStats = {
      totalExecs: 100000,
      calibrationExecs: 600,
      corpusSize: 200,
      solutionCount: 1,
      coverageEdges: 800,
      coverageFeatures: 1200,
      execsPerSec: 50000,
    };

    printSummary(state, stats, 5);

    const output = stderrSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(output).toContain("dedup skipped: 5");
  });

  it("first reportStatus after startReporting shows 0 new when corpus hasn't grown", () => {
    const state = createReporter(false);
    const stats: FuzzerStats = {
      totalExecs: 0,
      calibrationExecs: 0,
      corpusSize: 50,
      solutionCount: 0,
      coverageEdges: 100,
      coverageFeatures: 150,
      execsPerSec: 0,
    };

    startReporting(state, () => stats, 100_000);
    // After startReporting, lastCorpusSize should snapshot the initial corpusSize
    reportStatus(state, stats);
    stopReporting(state);

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toContain("(0 new)");
  });
});

describe("writeResultsFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-reporter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes valid JSON with all fields", () => {
    const filePath = path.join(tmpDir, "result.json");
    const content: ResultsFileContent = {
      crashed: false,
      crashCount: 0,
      crashArtifactPaths: [],
      duplicateCrashesSkipped: 0,
      totalExecs: 5000,
      calibrationExecs: 200,
      corpusSize: 50,
      solutionCount: 0,
      coverageEdges: 300,
      coverageFeatures: 450,
      execsPerSec: 10000,
      elapsedMs: 500,
    };

    writeResultsFile(filePath, content);

    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ResultsFileContent;
    expect(parsed.crashed).toBe(false);
    expect(parsed.totalExecs).toBe(5000);
    expect(parsed.calibrationExecs).toBe(200);
    expect(parsed.coverageFeatures).toBe(450);
    expect(parsed.error).toBeUndefined();
  });

  it("includes crash info when crashed", () => {
    const filePath = path.join(tmpDir, "crash-result.json");
    const content: ResultsFileContent = {
      crashed: true,
      crashCount: 2,
      crashArtifactPaths: ["/path/crash-a", "/path/crash-b"],
      duplicateCrashesSkipped: 1,
      totalExecs: 10000,
      calibrationExecs: 500,
      corpusSize: 80,
      solutionCount: 2,
      coverageEdges: 600,
      coverageFeatures: 900,
      execsPerSec: 20000,
      elapsedMs: 500,
      error: "test crash message",
    };

    writeResultsFile(filePath, content);

    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ResultsFileContent;
    expect(parsed.crashed).toBe(true);
    expect(parsed.crashCount).toBe(2);
    expect(parsed.crashArtifactPaths).toEqual([
      "/path/crash-a",
      "/path/crash-b",
    ]);
    expect(parsed.error).toBe("test crash message");
  });
});
