/**
 * Fuzzing progress reporter: periodic status to stderr.
 */
import { writeFileSync } from "node:fs";
import type { FuzzerStats } from "@vitiate/engine";
import { getInstrumentedEdgeCount } from "./globals.js";

/**
 * Coverage-map load fraction above which we warn about likely hash collisions.
 * At load L, the expected fraction of edges that share a slot with another edge
 * is roughly L (birthday approximation), so 0.02 corresponds to ~2% of edges
 * silently merging - the point where the granularity loss starts to matter.
 */
const COLLISION_PRESSURE_THRESHOLD = 0.02;

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
  detectors?: string[];
}

export function printBanner(info: BannerInfo): void {
  process.stderr.write(`vitiate: ${JSON.stringify(info)}\n`);
}

/**
 * Warn once if the number of instrumented edges is large relative to the
 * coverage-map size, which makes hash collisions (silently merged edges) likely
 * and coarsens coverage feedback. Call after the target modules have loaded so
 * `getInstrumentedEdgeCount()` reflects them. Emitting is independent of quiet
 * mode: it is a one-shot correctness diagnostic, not periodic status.
 *
 * :param mapSize: the configured coverage-map size (slot count).
 */
export function warnOnCoverageMapLoad(mapSize: number): void {
  const edgeCount = getInstrumentedEdgeCount();
  if (edgeCount <= 0 || mapSize <= 0) return;
  const load = edgeCount / mapSize;
  if (load < COLLISION_PRESSURE_THRESHOLD) return;
  const pct = (load * 100).toFixed(1);
  process.stderr.write(
    `vitiate: warning: ~${edgeCount} instrumented edges in a coverage map of ${mapSize} ` +
      `slots (${pct}% load); hash collisions may silently merge edges and coarsen ` +
      `coverage. Raise coverageMapSize to reduce collisions.\n`,
  );
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
    `fuzz: elapsed: ${elapsed}s, execs: ${stats.totalExecs} (${execsPerSec}/sec), cal: ${stats.calibrationExecs}, corpus: ${stats.corpusSize} (${newCorpus} new), edges: ${stats.coverageEdges}, ft: ${stats.coverageFeatures}\n`,
  );
}

export function printCrash(error: Error, artifactPath: string): void {
  process.stderr.write(
    `\nfuzz: CRASH FOUND: ${error.message}\nfuzz: crash artifact written to: ${artifactPath}\n`,
  );
}

export interface ResultsFileContent {
  crashed: boolean;
  crashCount: number;
  crashArtifactPaths: string[];
  duplicateCrashesSkipped: number;
  totalExecs: number;
  calibrationExecs: number;
  corpusSize: number;
  solutionCount: number;
  coverageEdges: number;
  coverageFeatures: number;
  execsPerSec: number;
  elapsedMs: number;
  error?: string;
}

export function writeResultsFile(
  filePath: string,
  content: ResultsFileContent,
): void {
  writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf-8");
}

export function printSummary(
  state: ReporterState,
  stats: FuzzerStats,
  duplicateCrashesSkipped = 0,
): void {
  if (state.quiet) return;
  const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
  let line = `\nfuzz: done - execs: ${stats.totalExecs}, cal: ${stats.calibrationExecs}, corpus: ${stats.corpusSize}, edges: ${stats.coverageEdges}, ft: ${stats.coverageFeatures}, elapsed: ${elapsed}s`;
  if (duplicateCrashesSkipped > 0) {
    line += `, dedup skipped: ${duplicateCrashesSkipped}`;
  }
  line += "\n";
  process.stderr.write(line);
}
