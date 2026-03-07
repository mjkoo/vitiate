/**
 * Corpus merge: set cover algorithm, coverage collection, and merge/optimize orchestration.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import {
  deleteCorpusEntry,
  loadCorpusDirsWithPaths,
  writeCorpusEntryToDir,
  type CorpusEntryWithPath,
} from "./corpus.js";

export interface SetCoverEntry {
  path: string;
  data: Buffer;
  edges: Set<number>;
}

/**
 * Greedy set cover: selects the minimal subset of entries whose edges
 * collectively cover the union of all edges across all entries.
 *
 * Tie-breaks by preferring smaller inputs (data.byteLength).
 *
 * When `preCovered` is provided, those edges are treated as already covered
 * (e.g., from seed corpus). Entries fully redundant with pre-covered edges
 * are eliminated.
 */
export function setCover(
  entries: SetCoverEntry[],
  preCovered?: Set<number>,
): SetCoverEntry[] {
  // Compute the union of all edges across all entries
  const allEdges = new Set<number>();
  for (const entry of entries) {
    for (const edge of entry.edges) {
      allEdges.add(edge);
    }
  }

  // If there are no edges to cover, nothing to select
  if (allEdges.size === 0) {
    return [];
  }

  const covered = new Set<number>(preCovered);
  const remaining = new Set(entries.keys());
  const selected: SetCoverEntry[] = [];

  while (true) {
    // Check if all edges from entries are covered
    let allCovered = true;
    for (const edge of allEdges) {
      if (!covered.has(edge)) {
        allCovered = false;
        break;
      }
    }
    if (allCovered) break;

    let bestIndex = -1;
    let bestUncovered = 0;
    let bestSize = Infinity;

    for (const i of remaining) {
      const entry = entries[i]!;
      let uncovered = 0;
      for (const edge of entry.edges) {
        if (!covered.has(edge)) {
          uncovered++;
        }
      }

      if (
        uncovered > bestUncovered ||
        (uncovered === bestUncovered && entry.data.byteLength < bestSize)
      ) {
        bestIndex = i;
        bestUncovered = uncovered;
        bestSize = entry.data.byteLength;
      }
    }

    // No remaining entry contributes new coverage
    if (bestIndex === -1 || bestUncovered === 0) break;

    const best = entries[bestIndex]!;
    for (const edge of best.edges) {
      covered.add(edge);
    }
    selected.push(best);
    remaining.delete(bestIndex);
  }

  return selected;
}

/**
 * Collect nonzero edge indices from a coverage map,
 * then zero the map to prepare for the next replay.
 */
export function collectEdges(coverageMap: Uint8Array): Set<number> {
  const edges = new Set<number>();
  for (let i = 0; i < coverageMap.length; i++) {
    if (coverageMap[i] !== 0) {
      edges.add(i);
    }
  }
  coverageMap.fill(0);
  return edges;
}

// -- Control file: JSON-lines with {path, edges} records --

interface ControlRecord {
  path: string;
  edges: number[];
}

/**
 * Read already-processed records from the control file.
 * Discards any partial trailing line (from a crash mid-write).
 */
export function readControlFile(
  filePath: string,
): { path: string; edges: Set<number> }[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const records: { path: string; edges: Set<number> }[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as ControlRecord;
      records.push({ path: parsed.path, edges: new Set(parsed.edges) });
    } catch {
      // Partial line from crash — discard
    }
  }
  return records;
}

/**
 * Append a single record to the control file.
 */
export function appendControlRecord(
  filePath: string,
  inputPath: string,
  edges: Set<number>,
): void {
  const record: ControlRecord = { path: inputPath, edges: [...edges] };
  appendFileSync(filePath, JSON.stringify(record) + "\n");
}

// -- Merge mode orchestration --

type FuzzTarget = (data: Buffer) => void | Promise<void>;

export interface MergeModeOptions {
  target: FuzzTarget;
  corpusDirs: string[];
  controlFilePath: string;
  coverageMap: Uint8Array;
}

/**
 * Run CLI merge mode: load entries, replay through target, collect coverage,
 * run set cover, write survivors to the output directory (first corpus dir).
 */
export async function runMergeMode(options: MergeModeOptions): Promise<void> {
  const { target, corpusDirs, controlFilePath, coverageMap } = options;
  const outputDir = corpusDirs[0]!;

  // Load all entries from all corpus directories
  const allEntries = loadCorpusDirsWithPaths(corpusDirs);
  process.stderr.write(
    `vitiate: merge: loaded ${allEntries.length} entries from ${corpusDirs.length} ${corpusDirs.length === 1 ? "directory" : "directories"}\n`,
  );

  if (allEntries.length === 0) {
    return;
  }

  // Resume from control file if it exists
  const existingRecords = readControlFile(controlFilePath);
  const processedPaths = new Set(existingRecords.map((r) => r.path));

  // Build set cover entries from existing records, filtering out stale entries
  const allEntryPaths = new Set(allEntries.map((e) => e.path));
  const setCoverEntries: SetCoverEntry[] = [];
  for (const r of existingRecords) {
    if (!allEntryPaths.has(r.path)) {
      process.stderr.write(
        `vitiate: merge: warning: discarding stale control record for ${r.path}\n`,
      );
      continue;
    }
    const entry = allEntries.find((e) => e.path === r.path);
    setCoverEntries.push({
      path: r.path,
      data: entry!.data,
      edges: r.edges,
    });
  }

  // Replay remaining entries
  const remaining = allEntries.filter((e) => !processedPaths.has(e.path));
  for (const entry of remaining) {
    try {
      await target(entry.data);
    } catch {
      process.stderr.write(
        `vitiate: merge: warning: skipping ${entry.path} (JS exception)\n`,
      );
      coverageMap.fill(0);
      continue;
    }

    const edges = collectEdges(coverageMap);
    appendControlRecord(controlFilePath, entry.path, edges);
    setCoverEntries.push({ path: entry.path, data: entry.data, edges });
  }

  // Collect unique edges
  const allEdges = new Set<number>();
  for (const entry of setCoverEntries) {
    for (const edge of entry.edges) {
      allEdges.add(edge);
    }
  }
  process.stderr.write(
    `vitiate: merge: replay complete, ${allEdges.size} unique edges covered\n`,
  );

  // Run set cover
  const survivors = setCover(setCoverEntries);
  const removed = setCoverEntries.length - survivors.length;
  process.stderr.write(
    `vitiate: merge: set cover selected ${survivors.length} entries (removed ${removed})\n`,
  );

  // Clean output directory and write survivors
  cleanDirectory(outputDir);
  for (const survivor of survivors) {
    writeCorpusEntryToDir(outputDir, survivor.data);
  }
  process.stderr.write(
    `vitiate: merge: wrote ${survivors.length} entries to ${outputDir}\n`,
  );
}

/**
 * Remove all files from a directory (but not subdirectories).
 */
function cleanDirectory(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith(".")) {
      rmSync(path.join(dir, entry.name));
    }
  }
}

// -- Optimize mode orchestration --

export interface OptimizeModeOptions {
  target: FuzzTarget;
  testName: string;
  seedEntries: CorpusEntryWithPath[];
  cachedEntries: CorpusEntryWithPath[];
  coverageMap: Uint8Array;
}

/**
 * Run Vitest optimize mode: replay seeds and cached entries, run set cover
 * with seed edges as pre-covered, delete non-surviving cached entries.
 */
export async function runOptimizeMode(
  options: OptimizeModeOptions,
): Promise<void> {
  const { target, testName, seedEntries, cachedEntries, coverageMap } = options;

  if (cachedEntries.length === 0) {
    process.stderr.write(
      `vitiate: optimize: test "${testName}" - no cached entries, skipping\n`,
    );
    return;
  }

  // Replay seed entries to collect pre-covered edges
  const preCovered = new Set<number>();
  let replayedSeeds = 0;
  for (const entry of seedEntries) {
    try {
      await target(entry.data);
    } catch {
      // Seed entries might throw; clear partial coverage and skip
      coverageMap.fill(0);
      continue;
    }
    const edges = collectEdges(coverageMap);
    for (const edge of edges) {
      preCovered.add(edge);
    }
    replayedSeeds++;
  }

  // Replay cached entries to collect their edges
  const cachedSetCoverEntries: SetCoverEntry[] = [];
  for (const entry of cachedEntries) {
    try {
      await target(entry.data);
    } catch {
      // Skip entries that throw
      coverageMap.fill(0);
      continue;
    }
    const edges = collectEdges(coverageMap);
    cachedSetCoverEntries.push({ path: entry.path, data: entry.data, edges });
  }

  // Count all unique edges (seeds + cached)
  const allEdges = new Set(preCovered);
  for (const entry of cachedSetCoverEntries) {
    for (const edge of entry.edges) {
      allEdges.add(edge);
    }
  }

  const totalReplayed = replayedSeeds + cachedSetCoverEntries.length;
  process.stderr.write(
    `vitiate: optimize: test "${testName}" - ${totalReplayed} entries, ${allEdges.size} edges\n`,
  );

  // Run set cover over cached entries only, with seed edges pre-covered
  const survivors = setCover(cachedSetCoverEntries, preCovered);
  const survivorPaths = new Set(survivors.map((s) => s.path));

  // Delete non-survivors
  let removed = 0;
  for (const entry of cachedEntries) {
    if (!survivorPaths.has(entry.path)) {
      deleteCorpusEntry(entry.path);
      removed++;
    }
  }

  process.stderr.write(
    `vitiate: optimize: test "${testName}" - kept ${survivors.length}, removed ${removed}\n`,
  );
}
