import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import {
  createReporter,
  startReporting,
  stopReporting,
  reportStatus,
  printCrash,
  printSummary,
} from "./reporter.js";
import type { FuzzerStats } from "vitiate-napi";

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
      corpusSize: 100,
      solutionCount: 0,
      coverageEdges: 500,
      execsPerSec: 25000,
    };

    reportStatus(state, stats);

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toContain("elapsed:");
    expect(output).toContain("execs: 50000");
    expect(output).toContain("25000/sec");
    expect(output).toContain("corpus: 100");
    expect(output).toContain("edges: 500");
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
      corpusSize: 200,
      solutionCount: 1,
      coverageEdges: 800,
      execsPerSec: 50000,
    };

    printSummary(state, stats);

    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(output).toContain("done");
    expect(output).toContain("execs: 100000");
    expect(output).toContain("corpus: 200");
    expect(output).toContain("edges: 800");
  });

  it("first reportStatus after startReporting shows 0 new when corpus hasn't grown", () => {
    const state = createReporter(false);
    const stats: FuzzerStats = {
      totalExecs: 0,
      corpusSize: 50,
      solutionCount: 0,
      coverageEdges: 100,
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
