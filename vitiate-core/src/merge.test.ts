import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  setCover,
  collectEdges,
  readControlFile,
  appendControlRecord,
  runMergeMode,
  runOptimizeMode,
} from "./merge.js";
import type { SetCoverEntry } from "./merge.js";

function entry(path: string, data: string, edges: number[]): SetCoverEntry {
  return { path, data: Buffer.from(data), edges: new Set(edges) };
}

describe("setCover", () => {
  it("selects both entries with disjoint edges", () => {
    const entries = [entry("a", "aa", [1, 2]), entry("b", "bb", [3, 4])];
    const result = setCover(entries);
    expect(result).toHaveLength(2);
  });

  it("eliminates fully redundant entry", () => {
    const entries = [entry("a", "aaa", [1, 2, 3]), entry("b", "bb", [1, 2])];
    const result = setCover(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("a");
  });

  it("tie-breaks by smaller input size", () => {
    const entries = [
      entry("a", "a".repeat(100), [1, 2, 3]),
      entry("b", "b".repeat(50), [1, 2, 3]),
    ];
    const result = setCover(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("b");
  });

  it("returns empty array for empty input", () => {
    expect(setCover([])).toEqual([]);
  });

  it("returns single entry when only one provided", () => {
    const entries = [entry("a", "aa", [1, 2])];
    const result = setCover(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("a");
  });

  it("excludes entries with no edges", () => {
    const entries = [entry("a", "aa", [1, 2]), entry("b", "bb", [])];
    const result = setCover(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("a");
  });

  it("returns empty array when all entries have empty edge sets", () => {
    const entries = [entry("a", "aa", []), entry("b", "bb", [])];
    expect(setCover(entries)).toEqual([]);
  });

  it("eliminates entries redundant with pre-covered edges", () => {
    const entries = [entry("a", "aa", [1, 2]), entry("b", "bb", [4, 5])];
    const result = setCover(entries, new Set([1, 2, 3]));
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("b");
  });

  it("returns empty array when pre-covered edges cover everything", () => {
    const entries = [entry("a", "aa", [1, 2]), entry("b", "bb", [2, 3])];
    const result = setCover(entries, new Set([1, 2, 3]));
    expect(result).toEqual([]);
  });

  it("uses greedy selection order (most uncovered edges first)", () => {
    const entries = [
      entry("a", "aaaa", [1, 2, 3, 4]),
      entry("b", "bbb", [1, 2, 5]),
      entry("c", "ccc", [3, 4, 6]),
    ];
    const result = setCover(entries);
    // A is selected first (4 uncovered), then need 5 and 6
    expect(result[0]!.path).toBe("a");
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Both remaining edges (5, 6) need to be covered
    const selectedPaths = new Set(result.map((r) => r.path));
    expect(selectedPaths.has("a")).toBe(true);
    // Verify all edges are covered by the selected set
    const coveredEdges = new Set<number>();
    for (const r of result) {
      for (const edge of r.edges) {
        coveredEdges.add(edge);
      }
    }
    expect(coveredEdges).toEqual(new Set([1, 2, 3, 4, 5, 6]));
  });
});

describe("collectEdges", () => {
  it("collects nonzero indices and zeros the map", () => {
    const map = new Uint8Array(65536);
    map[10] = 1;
    map[42] = 5;
    map[65535] = 255;

    const edges = collectEdges(map);
    expect(edges).toEqual(new Set([10, 42, 65535]));
    // Map should be zeroed
    for (let i = 0; i < map.length; i++) {
      expect(map[i]).toBe(0);
    }
  });

  it("returns empty set for all-zero map", () => {
    const map = new Uint8Array(65536);
    const edges = collectEdges(map);
    expect(edges.size).toBe(0);
    expect(map.every((b) => b === 0)).toBe(true);
  });
});

describe("control file", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("readControlFile returns empty array for nonexistent file", () => {
    const result = readControlFile(path.join(tmpDir, "missing.jsonl"));
    expect(result).toEqual([]);
  });

  it("appendControlRecord and readControlFile round-trip", () => {
    const filePath = path.join(tmpDir, "control.jsonl");
    appendControlRecord(filePath, "/input/a", new Set([1, 2, 3]));
    appendControlRecord(filePath, "/input/b", new Set([4, 5]));

    const records = readControlFile(filePath);
    expect(records).toHaveLength(2);
    expect(records[0]!.path).toBe("/input/a");
    expect(records[0]!.edges).toEqual(new Set([1, 2, 3]));
    expect(records[1]!.path).toBe("/input/b");
    expect(records[1]!.edges).toEqual(new Set([4, 5]));
  });

  it("readControlFile discards partial trailing line", () => {
    const filePath = path.join(tmpDir, "control.jsonl");
    appendControlRecord(filePath, "/input/a", new Set([1, 2]));
    // Simulate a crash mid-write by appending a partial line
    appendFileSync(filePath, '{"path":"/input/b","edges":[3,');

    const records = readControlFile(filePath);
    expect(records).toHaveLength(1);
    expect(records[0]!.path).toBe("/input/a");
  });
});

describe("runMergeMode", () => {
  let tmpDir: string;
  const originalStderrWrite = process.stderr.write;

  beforeEach(() => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    // Suppress stderr output during tests
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.stderr.write = originalStderrWrite;
  });

  it("merges corpus entries based on coverage", async () => {
    const corpusDir = path.join(tmpDir, "corpus");
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(path.join(corpusDir, "input1"), "aaa");
    writeFileSync(path.join(corpusDir, "input2"), "bbb");
    writeFileSync(path.join(corpusDir, "input3"), "ccc");

    const coverageMap = new Uint8Array(65536);

    const controlFile = path.join(tmpDir, "control.jsonl");

    await runMergeMode({
      target: (data: Buffer) => {
        const str = data.toString();
        if (str === "aaa") {
          coverageMap[10] = 1;
          coverageMap[20] = 1;
        } else if (str === "bbb") {
          coverageMap[10] = 1; // Redundant with input1
        } else if (str === "ccc") {
          coverageMap[30] = 1;
        }
      },
      corpusDirs: [corpusDir],
      controlFilePath: controlFile,
      coverageMap,
    });

    // input2 is redundant (edge 10 covered by input1), should be removed
    // Output dir should have 2 entries
    const survivors = readdirSync(corpusDir);
    expect(survivors).toHaveLength(2);
  });

  it("handles empty corpus", async () => {
    const corpusDir = path.join(tmpDir, "empty-corpus");
    mkdirSync(corpusDir, { recursive: true });

    const controlFile = path.join(tmpDir, "control.jsonl");
    const coverageMap = new Uint8Array(65536);

    // Should complete without error
    await runMergeMode({
      target: () => {},
      corpusDirs: [corpusDir],
      controlFilePath: controlFile,
      coverageMap,
    });
  });

  it("resumes from control file after simulated crash", async () => {
    const corpusDir = path.join(tmpDir, "corpus");
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(path.join(corpusDir, "input1"), "aaa");
    writeFileSync(path.join(corpusDir, "input2"), "bbb");

    const controlFile = path.join(tmpDir, "control.jsonl");

    // Pre-populate control file as if input1 was already processed
    const input1Path = path.join(corpusDir, "input1");
    appendControlRecord(controlFile, input1Path, new Set([10, 20]));

    const coverageMap = new Uint8Array(65536);
    let targetCalls = 0;

    await runMergeMode({
      target: (_data: Buffer) => {
        targetCalls++;
        coverageMap[30] = 1;
      },
      corpusDirs: [corpusDir],
      controlFilePath: controlFile,
      coverageMap,
    });

    // Only input2 should be replayed (input1 was in control file)
    expect(targetCalls).toBe(1);
  });

  it("skips entries that throw JS exceptions", async () => {
    const corpusDir = path.join(tmpDir, "corpus");
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(path.join(corpusDir, "good"), "good");
    writeFileSync(path.join(corpusDir, "bad"), "bad");

    const controlFile = path.join(tmpDir, "control.jsonl");
    const coverageMap = new Uint8Array(65536);

    await runMergeMode({
      target: (data: Buffer) => {
        if (data.toString() === "bad") {
          // Write partial coverage before throwing - stale edge 10
          coverageMap[10] = 1;
          throw new Error("target error");
        }
        coverageMap[20] = 1;
      },
      corpusDirs: [corpusDir],
      controlFilePath: controlFile,
      coverageMap,
    });

    // Only the good entry should survive
    const survivors = readdirSync(corpusDir);
    expect(survivors).toHaveLength(1);
  });

  it("cleans up temporary directories after successful merge", async () => {
    // Test the atomic swap recovery by making the output directory a symlink,
    // which will cause the second rename to fail on some platforms. Instead,
    // we test the recovery logic by using a read-only parent directory trick.
    // Simpler approach: use a corpus with one entry, then verify the rename-swap
    // contract by checking that if a tmpDir is left behind, the error propagates.
    const corpusDir = path.join(tmpDir, "corpus");
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(path.join(corpusDir, "input1"), "aaa");

    const coverageMap = new Uint8Array(65536);
    const controlFile = path.join(tmpDir, "control.jsonl");

    // Create a file at the path where the old directory would be renamed to,
    // blocking the first rename. This tests error propagation (the old→backup
    // rename will fail because a file with a similar prefix could conflict).
    // Actually, we can't reliably force a rename failure without mocking.
    // Instead, test the recovery contract: after a successful merge, verify
    // the .old directory is cleaned up (no leftover temp dirs).
    await runMergeMode({
      target: (_data: Buffer) => {
        coverageMap[10] = 1;
      },
      corpusDirs: [corpusDir],
      controlFilePath: controlFile,
      coverageMap,
    });

    // Verify no leftover .old or .vitiate-merge- directories
    const parentDir = path.dirname(path.resolve(corpusDir));
    const leftovers = readdirSync(parentDir).filter(
      (name) => name.includes(".old-") || name.includes(".vitiate-merge-"),
    );
    expect(leftovers).toEqual([]);
    // Corpus should still exist with merged content
    expect(existsSync(corpusDir)).toBe(true);
  });
});

describe("runOptimizeMode", () => {
  let tmpDir: string;
  const originalStderrWrite = process.stderr.write;

  beforeEach(() => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-optimize-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.stderr.write = originalStderrWrite;
  });

  function writeCachedEntry(name: string, content: string): string {
    const filePath = path.join(tmpDir, "cached", name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    return filePath;
  }

  it("reduces corpus by removing redundant cached entries", async () => {
    const path1 = writeCachedEntry("entry1", "aaa");
    const path2 = writeCachedEntry("entry2", "bbb");
    const path3 = writeCachedEntry("entry3", "ccc");

    const coverageMap = new Uint8Array(65536);

    await runOptimizeMode({
      target: (data: Buffer) => {
        const str = data.toString();
        if (str === "aaa") {
          coverageMap[10] = 1;
          coverageMap[20] = 1;
        } else if (str === "bbb") {
          coverageMap[10] = 1; // Redundant with entry1
        } else if (str === "ccc") {
          coverageMap[30] = 1;
        }
      },
      testName: "test-reduce",
      seedEntries: [],
      cachedEntries: [
        { path: path1, data: Buffer.from("aaa") },
        { path: path2, data: Buffer.from("bbb") },
        { path: path3, data: Buffer.from("ccc") },
      ],
      coverageMap,
    });

    // entry2 is redundant - should be deleted
    expect(existsSync(path1)).toBe(true);
    expect(existsSync(path2)).toBe(false);
    expect(existsSync(path3)).toBe(true);
  });

  it("skips cached entries that throw", async () => {
    const path1 = writeCachedEntry("good", "good");
    const path2 = writeCachedEntry("bad", "bad");

    const coverageMap = new Uint8Array(65536);

    await runOptimizeMode({
      target: (data: Buffer) => {
        if (data.toString() === "bad") {
          coverageMap[99] = 1;
          throw new Error("target error");
        }
        coverageMap[10] = 1;
      },
      testName: "test-skip-throw",
      seedEntries: [],
      cachedEntries: [
        { path: path1, data: Buffer.from("good") },
        { path: path2, data: Buffer.from("bad") },
      ],
      coverageMap,
    });

    // good survives, bad is deleted (it threw so never entered set cover)
    expect(existsSync(path1)).toBe(true);
    expect(existsSync(path2)).toBe(false);
  });

  it("removes all cached when seeds cover everything", async () => {
    const path1 = writeCachedEntry("entry1", "cached1");

    const coverageMap = new Uint8Array(65536);

    await runOptimizeMode({
      target: (data: Buffer) => {
        const str = data.toString();
        if (str === "seed") {
          coverageMap[10] = 1;
          coverageMap[20] = 1;
        } else if (str === "cached1") {
          coverageMap[10] = 1; // Subset of seed coverage
        }
      },
      testName: "test-seeds-cover-all",
      seedEntries: [{ path: "seed-0", data: Buffer.from("seed") }],
      cachedEntries: [{ path: path1, data: Buffer.from("cached1") }],
      coverageMap,
    });

    // cached entry is fully redundant with seed coverage
    expect(existsSync(path1)).toBe(false);
  });

  it("no-op when cached corpus is empty", async () => {
    const coverageMap = new Uint8Array(65536);

    // Should return without error and without calling target
    let targetCalled = false;
    await runOptimizeMode({
      target: () => {
        targetCalled = true;
      },
      testName: "test-empty-cached",
      seedEntries: [{ path: "seed-0", data: Buffer.from("seed") }],
      cachedEntries: [],
      coverageMap,
    });

    expect(targetCalled).toBe(false);
  });

  it("seed entries that throw do not pollute cached entry edges", async () => {
    const pathA = writeCachedEntry("entryA", "cachedA");
    const pathB = writeCachedEntry("entryB", "cachedB");

    const coverageMap = new Uint8Array(65536);

    await runOptimizeMode({
      target: (data: Buffer) => {
        const str = data.toString();
        if (str === "bad-seed") {
          // Write partial coverage before throwing - edge 10 is stale
          coverageMap[10] = 1;
          throw new Error("seed error");
        } else if (str === "cachedA") {
          coverageMap[20] = 1;
        } else if (str === "cachedB") {
          coverageMap[10] = 1;
        }
      },
      testName: "test-seed-throw-no-pollute",
      seedEntries: [{ path: "seed-0", data: Buffer.from("bad-seed") }],
      cachedEntries: [
        { path: pathA, data: Buffer.from("cachedA") },
        { path: pathB, data: Buffer.from("cachedB") },
      ],
      coverageMap,
    });

    // Without coverageMap.fill(0) in seed throw handler: stale edge 10 leaks
    // into cachedA's collectEdges → A appears to cover {10, 20}, B covers {10}
    // → B is redundant → deleted. But A doesn't actually cover edge 10.
    // With the fix: A covers {20}, B covers {10} → both unique → both kept.
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);
  });
});
