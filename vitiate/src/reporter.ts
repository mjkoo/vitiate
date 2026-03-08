/**
 * Fuzzing progress reporter: periodic status to stderr.
 */
import type { FuzzerStats } from "vitiate-napi";

export interface ReporterState {
  startTime: number;
  intervalId: ReturnType<typeof setInterval> | null;
  lastCorpusSize: number;
  quiet: boolean;
}

export interface BannerInfo {
  testName: string;
  maxLen: number;
  timeoutMs: number | undefined;
  seed: number | undefined;
  corpusSize: number;
  mapSize: number;
}

export function printBanner(info: BannerInfo): void {
  process.stderr.write(`vitiate: ${JSON.stringify(info)}\n`);
}

export function createReporter(quiet: boolean): ReporterState {
  return {
    startTime: Date.now(),
    intervalId: null,
    lastCorpusSize: 0,
    quiet,
  };
}

export function startReporting(
  state: ReporterState,
  getStats: () => FuzzerStats,
  intervalMs: number = 3000,
): void {
  state.startTime = Date.now();
  state.lastCorpusSize = getStats().corpusSize;
  if (state.quiet) return;
  state.intervalId = setInterval(() => {
    reportStatus(state, getStats());
  }, intervalMs);
  state.intervalId.unref();
}

export function stopReporting(state: ReporterState): void {
  if (state.intervalId !== null) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
}

export function reportStatus(state: ReporterState, stats: FuzzerStats): void {
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const newCorpus = Math.max(0, stats.corpusSize - state.lastCorpusSize);
  state.lastCorpusSize = stats.corpusSize;
  const execsPerSec = Number.isFinite(stats.execsPerSec)
    ? Math.floor(stats.execsPerSec)
    : 0;
  process.stderr.write(
    `fuzz: elapsed: ${elapsed}s, execs: ${stats.totalExecs} (${execsPerSec}/sec), corpus: ${stats.corpusSize} (${newCorpus} new), edges: ${stats.coverageEdges}\n`,
  );
}

export function printCrash(error: Error, artifactPath: string): void {
  process.stderr.write(
    `\nfuzz: CRASH FOUND: ${error.message}\nfuzz: crash artifact written to: ${artifactPath}\n`,
  );
}

export function printSummary(
  state: ReporterState,
  stats: FuzzerStats,
  duplicateCrashesSkipped = 0,
): void {
  if (state.quiet) return;
  const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
  let line = `\nfuzz: done - execs: ${stats.totalExecs}, corpus: ${stats.corpusSize}, edges: ${stats.coverageEdges}, elapsed: ${elapsed}s`;
  if (duplicateCrashesSkipped > 0) {
    line += `, dedup skipped: ${duplicateCrashesSkipped}`;
  }
  line += "\n";
  process.stderr.write(line);
}
