import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  loadSeedCorpus,
  loadCachedCorpus,
  loadCachedCorpusWithPaths,
  loadCorpusDirsWithPaths,
  deleteCorpusEntry,
  writeCorpusEntry,
  writeCorpusEntryToDir,
  writeArtifact,
  writeArtifactWithPrefix,
  replaceArtifact,
  sanitizeTestName,
  getCacheDir,
  loadCorpusFromDirs,
  getDictionaryPath,
} from "./corpus.js";
import {
  setProjectRoot,
  resetProjectRoot,
  setCacheDir,
  resetCacheDir,
} from "./config.js";

describe("corpus", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-corpus-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadSeedCorpus", () => {
    it("returns empty array when directory does not exist", () => {
      const result = loadSeedCorpus(tmpDir, "nonexistent");
      expect(result).toEqual([]);
    });

    it("returns empty array when directory is empty", () => {
      const dirName = sanitizeTestName("empty");
      const dir = path.join(tmpDir, "testdata", "fuzz", dirName);
      mkdirSync(dir, { recursive: true });
      const result = loadSeedCorpus(tmpDir, "empty");
      expect(result).toEqual([]);
    });

    it("loads all files from seed corpus directory", () => {
      const dirName = sanitizeTestName("parse");
      const dir = path.join(tmpDir, "testdata", "fuzz", dirName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "seed1"), "hello");
      writeFileSync(path.join(dir, "seed2"), "world");
      writeFileSync(path.join(dir, "crash-abc123"), "crash input");

      const result = loadSeedCorpus(tmpDir, "parse");
      expect(result).toHaveLength(3);
      const contents = result.map((b) => b.toString()).sort();
      expect(contents).toEqual(["crash input", "hello", "world"]);
    });

    it("skips subdirectories in seed corpus", () => {
      const dirName = sanitizeTestName("withsubdir");
      const dir = path.join(tmpDir, "testdata", "fuzz", dirName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "seed1"), "hello");
      mkdirSync(path.join(dir, "subdir"), { recursive: true });
      writeFileSync(path.join(dir, "subdir", "nested"), "should be ignored");

      const result = loadSeedCorpus(tmpDir, "withsubdir");
      expect(result).toHaveLength(1);
      expect(result[0]!.toString()).toBe("hello");
    });
  });

  describe("loadCachedCorpus", () => {
    it("returns empty array when directory does not exist", () => {
      const result = loadCachedCorpus(tmpDir, "test.fuzz.ts", "nonexistent");
      expect(result).toEqual([]);
    });

    it("loads all files from cached corpus directory", () => {
      const dirName = sanitizeTestName("parse");
      const dir = path.join(tmpDir, "test.fuzz.ts", dirName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "a1b2c3d4"), "data1");
      writeFileSync(path.join(dir, "e5f6g7h8"), "data2");

      const result = loadCachedCorpus(tmpDir, "test.fuzz.ts", "parse");
      expect(result).toHaveLength(2);
    });

    it("skips subdirectories in cached corpus", () => {
      const dirName = sanitizeTestName("withsubdir");
      const dir = path.join(tmpDir, "test.fuzz.ts", dirName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "a1b2c3d4"), "data1");
      mkdirSync(path.join(dir, "subdir"), { recursive: true });
      writeFileSync(path.join(dir, "subdir", "nested"), "should be ignored");

      const result = loadCachedCorpus(tmpDir, "test.fuzz.ts", "withsubdir");
      expect(result).toHaveLength(1);
      expect(result[0]!.toString()).toBe("data1");
    });
  });

  describe("writeCorpusEntry", () => {
    it("writes a corpus entry and returns the path", () => {
      const data = Buffer.from("interesting input");
      const filePath = writeCorpusEntry(tmpDir, "test.fuzz.ts", "parse", data);

      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(data);
    });

    it("creates directories on demand", () => {
      const cacheDir = path.join(tmpDir, "deeply", "nested");
      const data = Buffer.from("data");
      const filePath = writeCorpusEntry(cacheDir, "test.fuzz.ts", "test", data);

      expect(existsSync(filePath)).toBe(true);
    });

    it("is idempotent - duplicate writes do not overwrite", () => {
      const data = Buffer.from("same input");
      const path1 = writeCorpusEntry(tmpDir, "test.fuzz.ts", "parse", data);
      const path2 = writeCorpusEntry(tmpDir, "test.fuzz.ts", "parse", data);

      expect(path1).toBe(path2);
    });

    it("round-trips: write then load returns same data", () => {
      const data = Buffer.from("round trip test");
      writeCorpusEntry(tmpDir, "test.fuzz.ts", "parse", data);

      const loaded = loadCachedCorpus(tmpDir, "test.fuzz.ts", "parse");
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(data);
    });
  });

  describe("writeArtifact", () => {
    it("writes a crash artifact with crash- prefix", () => {
      const data = Buffer.from("crash input");
      const filePath = writeArtifact(tmpDir, "parse", data);

      expect(path.basename(filePath)).toMatch(/^crash-[0-9a-f]{64}$/);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(data);
    });

    it("creates directories on demand", () => {
      const testDir = path.join(tmpDir, "deeply", "nested");
      const data = Buffer.from("crash");
      const filePath = writeArtifact(testDir, "test", data);

      expect(existsSync(filePath)).toBe(true);
    });

    it("is idempotent - duplicate writes do not overwrite", () => {
      const data = Buffer.from("same crash");
      const path1 = writeArtifact(tmpDir, "parse", data);
      const path2 = writeArtifact(tmpDir, "parse", data);

      expect(path1).toBe(path2);
    });

    it("round-trips: crash artifact can be loaded as seed corpus", () => {
      const data = Buffer.from("crash round trip");
      writeArtifact(tmpDir, "parse", data);

      const loaded = loadSeedCorpus(tmpDir, "parse");
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(data);
    });

    it("writes a timeout artifact with timeout- prefix", () => {
      const data = Buffer.from("timeout input");
      const filePath = writeArtifact(tmpDir, "parse", data, "timeout");

      expect(path.basename(filePath)).toMatch(/^timeout-[0-9a-f]{64}$/);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(data);
    });
  });

  describe("writeCorpusEntryToDir", () => {
    it("writes an entry with content hash as filename", () => {
      const dir = path.join(tmpDir, "corpus");
      const data = Buffer.from("interesting input");
      const filePath = writeCorpusEntryToDir(dir, data);

      expect(path.dirname(filePath)).toBe(dir);
      expect(path.basename(filePath)).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(data);
    });

    it("creates directory recursively on demand", () => {
      const dir = path.join(tmpDir, "deeply", "nested", "corpus");
      const data = Buffer.from("data");
      const filePath = writeCorpusEntryToDir(dir, data);

      expect(existsSync(filePath)).toBe(true);
    });

    it("is idempotent - duplicate writes do not overwrite", () => {
      const dir = path.join(tmpDir, "corpus");
      const data = Buffer.from("same input");
      const path1 = writeCorpusEntryToDir(dir, data);
      const path2 = writeCorpusEntryToDir(dir, data);

      expect(path1).toBe(path2);
    });
  });

  describe("writeArtifactWithPrefix", () => {
    it("writes crash artifact with directory prefix", () => {
      const prefix = path.join(tmpDir, "out") + path.sep;
      const data = Buffer.from("crash input");
      const filePath = writeArtifactWithPrefix(prefix, data, "crash");

      const expectedHash = createHash("sha256").update(data).digest("hex");
      expect(filePath).toBe(`${prefix}crash-${expectedHash}`);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(data);
    });

    it("writes artifact with non-directory prefix", () => {
      const prefix = path.join(tmpDir, "bug-");
      const data = Buffer.from("crash input");
      const filePath = writeArtifactWithPrefix(prefix, data, "crash");

      expect(path.basename(filePath)).toMatch(/^bug-crash-[0-9a-f]{64}$/);
      expect(existsSync(filePath)).toBe(true);
    });

    it("writes timeout artifact", () => {
      const prefix = path.join(tmpDir, "out") + path.sep;
      const data = Buffer.from("timeout input");
      const filePath = writeArtifactWithPrefix(prefix, data, "timeout");

      expect(path.basename(filePath)).toMatch(/^timeout-[0-9a-f]{64}$/);
      expect(existsSync(filePath)).toBe(true);
    });

    it("creates parent directory on demand", () => {
      const prefix = path.join(tmpDir, "findings", "sub") + path.sep;
      const data = Buffer.from("data");
      const filePath = writeArtifactWithPrefix(prefix, data, "crash");

      expect(existsSync(filePath)).toBe(true);
    });

    it("is idempotent - duplicate writes do not overwrite", () => {
      const prefix = path.join(tmpDir, "out") + path.sep;
      const data = Buffer.from("same crash");
      const path1 = writeArtifactWithPrefix(prefix, data, "crash");
      const path2 = writeArtifactWithPrefix(prefix, data, "crash");

      expect(path1).toBe(path2);
    });
  });

  describe("sanitizeTestName", () => {
    it("produces hash-slug format for simple name", () => {
      const result = sanitizeTestName("parse-url");
      expect(result).toMatch(/^[0-9a-f]{8}-parse-url$/);
    });

    it("produces different hashes for names that differ only in non-alphanumeric chars", () => {
      const a = sanitizeTestName("parse url");
      const b = sanitizeTestName("parse:url");
      // Both have same slug but different hashes
      expect(a).toMatch(/-parse_url$/);
      expect(b).toMatch(/-parse_url$/);
      expect(a).not.toBe(b);
    });

    it("produces hash-only for empty string", () => {
      const result = sanitizeTestName("");
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });

    it("produces hash-only for only special chars", () => {
      const result = sanitizeTestName("///");
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });

    it("produces hash-only for single dot", () => {
      const result = sanitizeTestName(".");
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });

    it("produces hash-only for double dot", () => {
      const result = sanitizeTestName("..");
      expect(result).toMatch(/^[0-9a-f]{8}$/);
    });

    it("preserves dots dashes and alphanumerics in slug", () => {
      const result = sanitizeTestName("valid-name_1.0");
      expect(result).toMatch(/^[0-9a-f]{8}-valid-name_1\.0$/);
    });

    it("collapses runs of underscores in slug", () => {
      const result = sanitizeTestName("a///b");
      expect(result).toMatch(/^[0-9a-f]{8}-a_b$/);
    });

    it("replaces spaces in slug", () => {
      const result = sanitizeTestName("my test name");
      expect(result).toMatch(/^[0-9a-f]{8}-my_test_name$/);
    });

    it("same name always produces the same result (deterministic)", () => {
      expect(sanitizeTestName("parse-url")).toBe(sanitizeTestName("parse-url"));
    });
  });

  describe("file-qualified cached corpus prevents cross-file collisions", () => {
    it("same test name in different files produces distinct cache paths", () => {
      const data = Buffer.from("test data");
      const path1 = writeCorpusEntry(tmpDir, "test/url.fuzz.ts", "parse", data);
      const path2 = writeCorpusEntry(
        tmpDir,
        "test/json.fuzz.ts",
        "parse",
        data,
      );

      // Same file name, different parent directories
      expect(path1).not.toBe(path2);

      // Each loads only its own entry
      const loaded1 = loadCachedCorpus(tmpDir, "test/url.fuzz.ts", "parse");
      const loaded2 = loadCachedCorpus(tmpDir, "test/json.fuzz.ts", "parse");
      expect(loaded1).toHaveLength(1);
      expect(loaded2).toHaveLength(1);
    });

    it("empty/degenerate names produce valid hash-only directories", () => {
      const data = Buffer.from("test data");
      const filePath = writeCorpusEntry(tmpDir, "test.fuzz.ts", "", data);
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe("getCacheDir", () => {
    afterEach(() => {
      resetCacheDir();
      resetProjectRoot();
    });

    it("uses project root for default .vitiate-corpus when project root is set", () => {
      setProjectRoot("/home/user/project");
      const dir = getCacheDir();
      expect(dir).toBe(path.resolve("/home/user/project", ".vitiate-corpus"));
    });

    it("returns resolved cache dir when set", () => {
      setCacheDir(path.resolve("/home/user/project", ".my-corpus"));
      setProjectRoot("/home/user/project");
      const dir = getCacheDir();
      expect(dir).toBe(path.resolve("/home/user/project", ".my-corpus"));
    });

    it("returns absolute cache dir as-is", () => {
      setCacheDir("/absolute/path");
      setProjectRoot("/home/user/project");
      const dir = getCacheDir();
      expect(dir).toBe("/absolute/path");
    });

    it("falls back to cwd when no project root is set", () => {
      const dir = getCacheDir();
      expect(dir).toBe(path.resolve(process.cwd(), ".vitiate-corpus"));
    });

    it("returns an absolute path in all cases", () => {
      expect(path.isAbsolute(getCacheDir())).toBe(true);
    });
  });

  describe("loadCorpusFromDirs", () => {
    it("returns empty array for nonexistent dirs", () => {
      const result = loadCorpusFromDirs(["/nonexistent/dir"]);
      expect(result).toEqual([]);
    });

    it("loads files from multiple directories", () => {
      const dir1 = path.join(tmpDir, "corpus1");
      const dir2 = path.join(tmpDir, "corpus2");
      mkdirSync(dir1, { recursive: true });
      mkdirSync(dir2, { recursive: true });
      writeFileSync(path.join(dir1, "a"), "aaa");
      writeFileSync(path.join(dir2, "b"), "bbb");

      const result = loadCorpusFromDirs([dir1, dir2]);
      expect(result).toHaveLength(2);
      const contents = result.map((b) => b.toString()).sort();
      expect(contents).toEqual(["aaa", "bbb"]);
    });
  });

  describe("loadCachedCorpusWithPaths", () => {
    it("returns empty array when directory does not exist", () => {
      const result = loadCachedCorpusWithPaths(
        tmpDir,
        "test.fuzz.ts",
        "nonexistent",
      );
      expect(result).toEqual([]);
    });

    it("returns entries with absolute paths and data", () => {
      const dirName = sanitizeTestName("parse");
      const dir = path.join(tmpDir, "test.fuzz.ts", dirName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "a1b2c3d4"), "data1");
      writeFileSync(path.join(dir, "e5f6g7h8"), "data2");

      const result = loadCachedCorpusWithPaths(tmpDir, "test.fuzz.ts", "parse");
      expect(result).toHaveLength(2);
      for (const entry of result) {
        expect(path.isAbsolute(entry.path)).toBe(true);
        expect(entry.data).toBeInstanceOf(Buffer);
      }
      const contents = result.map((e) => e.data.toString()).sort();
      expect(contents).toEqual(["data1", "data2"]);
    });
  });

  describe("loadCorpusDirsWithPaths", () => {
    it("returns entries with paths from multiple directories", () => {
      const dir1 = path.join(tmpDir, "corpus1");
      const dir2 = path.join(tmpDir, "corpus2");
      mkdirSync(dir1, { recursive: true });
      mkdirSync(dir2, { recursive: true });
      writeFileSync(path.join(dir1, "abc"), "aaa");
      writeFileSync(path.join(dir2, "def"), "bbb");

      const result = loadCorpusDirsWithPaths([dir1, dir2]);
      expect(result).toHaveLength(2);
      for (const entry of result) {
        expect(path.isAbsolute(entry.path)).toBe(true);
        expect(entry.data).toBeInstanceOf(Buffer);
      }
    });

    it("returns empty array for nonexistent directories", () => {
      const result = loadCorpusDirsWithPaths(["/nonexistent/dir"]);
      expect(result).toEqual([]);
    });

    it("skips nonexistent directories but returns entries from existing ones", () => {
      const dir = path.join(tmpDir, "corpus");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "abc"), "data");

      const result = loadCorpusDirsWithPaths(["/nonexistent/dir", dir]);
      expect(result).toHaveLength(1);
      expect(result[0]!.data.toString()).toBe("data");
    });
  });

  describe("deleteCorpusEntry", () => {
    it("deletes an existing file", () => {
      const filePath = path.join(tmpDir, "entry");
      writeFileSync(filePath, "data");
      expect(existsSync(filePath)).toBe(true);

      deleteCorpusEntry(filePath);
      expect(existsSync(filePath)).toBe(false);
    });

    it("silently succeeds when file does not exist", () => {
      const filePath = path.join(tmpDir, "nonexistent");
      expect(() => deleteCorpusEntry(filePath)).not.toThrow();
    });

    it("propagates non-ENOENT errors", () => {
      // Attempt to delete a directory (which will fail with EISDIR/EPERM)
      const dirPath = path.join(tmpDir, "adir");
      mkdirSync(dirPath, { recursive: true });
      expect(() => deleteCorpusEntry(dirPath)).toThrow();
    });
  });

  describe("replaceArtifact", () => {
    it("replaces artifact with correct filename and deletes old file", () => {
      const oldData = Buffer.from("old crash data");
      const newData = Buffer.from("new smaller");
      const oldPath = writeArtifactWithPrefix(
        path.join(tmpDir, "out") + path.sep,
        oldData,
        "crash",
      );

      expect(existsSync(oldPath)).toBe(true);

      const newPath = replaceArtifact(oldPath, newData, "crash");

      // New file exists with correct content
      expect(existsSync(newPath)).toBe(true);
      expect(readFileSync(newPath)).toEqual(newData);

      // New filename follows crash-{hash} pattern
      const expectedHash = createHash("sha256").update(newData).digest("hex");
      expect(path.basename(newPath)).toBe(`crash-${expectedHash}`);

      // Old file is deleted
      expect(existsSync(oldPath)).toBe(false);
    });

    it("handles same-hash case (overwrite in place)", () => {
      const data = Buffer.from("same data");
      const oldPath = writeArtifactWithPrefix(
        path.join(tmpDir, "out") + path.sep,
        data,
        "crash",
      );

      const newPath = replaceArtifact(oldPath, data, "crash");

      expect(newPath).toBe(oldPath);
      expect(existsSync(newPath)).toBe(true);
      expect(readFileSync(newPath)).toEqual(data);
    });

    it("writes atomically via temp file and rename", () => {
      const oldData = Buffer.from("original");
      const newData = Buffer.from("replacement");
      const oldPath = writeArtifactWithPrefix(
        path.join(tmpDir, "out") + path.sep,
        oldData,
        "crash",
      );

      const newPath = replaceArtifact(oldPath, newData, "crash");

      // Result is correct - the rename completed successfully
      expect(existsSync(newPath)).toBe(true);
      expect(readFileSync(newPath)).toEqual(newData);

      // No temp files left behind
      const dir = path.join(tmpDir, "out");
      const files = readdirSync(dir);
      expect(files.every((f) => !f.startsWith(".tmp-"))).toBe(true);
    });

    it("works with timeout artifacts", () => {
      const oldData = Buffer.from("timeout data");
      const newData = Buffer.from("smaller");
      const oldPath = writeArtifactWithPrefix(
        path.join(tmpDir, "out") + path.sep,
        oldData,
        "timeout",
      );

      const newPath = replaceArtifact(oldPath, newData, "timeout");

      expect(path.basename(newPath)).toMatch(/^timeout-[0-9a-f]{64}$/);
      expect(existsSync(newPath)).toBe(true);
      expect(existsSync(oldPath)).toBe(false);
    });
  });

  describe("getDictionaryPath", () => {
    it("returns path when .dict file exists", () => {
      const dirName = sanitizeTestName("parse-json");
      const dictPath = path.join(tmpDir, "testdata", "fuzz", `${dirName}.dict`);
      mkdirSync(path.dirname(dictPath), { recursive: true });
      writeFileSync(dictPath, '"true"\n"false"\n');

      const result = getDictionaryPath(tmpDir, "parse-json");
      expect(result).toBe(dictPath);
    });

    it("returns undefined when .dict file does not exist", () => {
      const result = getDictionaryPath(tmpDir, "nonexistent-test");
      expect(result).toBeUndefined();
    });

    it("does not confuse seed corpus directory with dictionary file", () => {
      const dirName = sanitizeTestName("my-test");
      const corpusDir = path.join(tmpDir, "testdata", "fuzz", dirName);
      mkdirSync(corpusDir, { recursive: true });
      writeFileSync(path.join(corpusDir, "seed1"), "data");
      // No .dict file - only the corpus directory exists.

      const result = getDictionaryPath(tmpDir, "my-test");
      expect(result).toBeUndefined();
    });
  });
});
