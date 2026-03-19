import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  loadCachedCorpus,
  loadCachedCorpusWithPaths,
  loadCorpusDirsWithPaths,
  deleteCorpusEntry,
  writeCorpusEntry,
  writeCorpusEntryToDir,
  writeArtifact,
  writeArtifactWithPrefix,
  replaceArtifact,
  loadCorpusFromDirs,
  discoverDictionaries,
  loadTestDataCorpus,
  getTestDataDir,
  getCorpusDir,
} from "./corpus.js";
import {
  setProjectRoot,
  resetProjectRoot,
  setDataDir,
  resetDataDir,
  getDataDir,
} from "./config.js";
import { hashTestPath } from "./nix-base32.js";

describe("corpus", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-corpus-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    setDataDir(tmpDir);
  });

  afterEach(() => {
    resetDataDir();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadTestDataCorpus with seeds only", () => {
    it("returns empty array when directory does not exist", () => {
      const result = loadTestDataCorpus("test.fuzz.ts", "nonexistent");
      expect(result).toEqual([]);
    });

    it("returns empty array when seeds directory is empty", () => {
      const hashDir = hashTestPath("test.fuzz.ts", "empty");
      const dir = path.join(tmpDir, "testdata", hashDir, "seeds");
      mkdirSync(dir, { recursive: true });
      const result = loadTestDataCorpus("test.fuzz.ts", "empty");
      expect(result).toEqual([]);
    });

    it("loads all files from seeds subdirectory", () => {
      const hashDir = hashTestPath("test.fuzz.ts", "parse");
      const dir = path.join(tmpDir, "testdata", hashDir, "seeds");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "seed1"), "hello");
      writeFileSync(path.join(dir, "seed2"), "world");
      writeFileSync(path.join(dir, "seed3"), "extra");

      const result = loadTestDataCorpus("test.fuzz.ts", "parse");
      expect(result).toHaveLength(3);
      const contents = result.map((b) => b.toString()).sort();
      expect(contents).toEqual(["extra", "hello", "world"]);
    });

    it("skips nested subdirectories within seeds", () => {
      const hashDir = hashTestPath("test.fuzz.ts", "withsubdir");
      const dir = path.join(tmpDir, "testdata", hashDir, "seeds");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "seed1"), "hello");
      mkdirSync(path.join(dir, "subdir"), { recursive: true });
      writeFileSync(path.join(dir, "subdir", "nested"), "should be ignored");

      const result = loadTestDataCorpus("test.fuzz.ts", "withsubdir");
      expect(result).toHaveLength(1);
      expect(result[0]!.toString()).toBe("hello");
    });
  });

  describe("loadCachedCorpus", () => {
    it("returns empty array when directory does not exist", () => {
      const result = loadCachedCorpus("test.fuzz.ts", "nonexistent");
      expect(result).toEqual([]);
    });

    it("loads all files from cached corpus directory", () => {
      const hashDir = hashTestPath("test.fuzz.ts", "parse");
      const dir = path.join(tmpDir, "corpus", hashDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "a1b2c3d4"), "data1");
      writeFileSync(path.join(dir, "e5f6g7h8"), "data2");

      const result = loadCachedCorpus("test.fuzz.ts", "parse");
      expect(result).toHaveLength(2);
    });

    it("skips subdirectories in cached corpus", () => {
      const hashDir = hashTestPath("test.fuzz.ts", "withsubdir");
      const dir = path.join(tmpDir, "corpus", hashDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "a1b2c3d4"), "data1");
      mkdirSync(path.join(dir, "subdir"), { recursive: true });
      writeFileSync(path.join(dir, "subdir", "nested"), "should be ignored");

      const result = loadCachedCorpus("test.fuzz.ts", "withsubdir");
      expect(result).toHaveLength(1);
      expect(result[0]!.toString()).toBe("data1");
    });
  });

  describe("writeCorpusEntry", () => {
    it("writes a corpus entry and returns the path", () => {
      const data = Buffer.from("interesting input");
      const filePath = writeCorpusEntry("test.fuzz.ts", "parse", data);

      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(data);
    });

    it("creates directories on demand", () => {
      const nestedDir = path.join(tmpDir, "deeply", "nested");
      setDataDir(nestedDir);
      const data = Buffer.from("data");
      const filePath = writeCorpusEntry("test.fuzz.ts", "test", data);

      expect(existsSync(filePath)).toBe(true);
    });

    it("is idempotent - duplicate writes do not overwrite", () => {
      const data = Buffer.from("same input");
      const path1 = writeCorpusEntry("test.fuzz.ts", "parse", data);
      const path2 = writeCorpusEntry("test.fuzz.ts", "parse", data);

      expect(path1).toBe(path2);
    });

    // chmod 0o444 does not enforce write protection on Windows (ACL-based),
    // and root on Linux bypasses POSIX permission checks.
    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "throws on write to read-only directory",
      () => {
        const readOnlyDir = path.join(tmpDir, "readonly-corpus");
        mkdirSync(readOnlyDir, { recursive: true });
        // Point data dir at a path where the corpus subdir is read-only.
        // writeCorpusEntry creates <dataDir>/corpus/<hash>/<file>, so we need
        // the corpus/<hash> directory to exist and be read-only.
        setDataDir(readOnlyDir);
        // Write once to create the nested directory structure
        const data = Buffer.from("first write");
        writeCorpusEntry("test.fuzz.ts", "rotest", data);
        // Make the corpus hash directory read-only
        const corpusDir = path.dirname(
          writeCorpusEntry("test.fuzz.ts", "rotest", data),
        );
        chmodSync(corpusDir, 0o444);
        try {
          expect(() =>
            writeCorpusEntry("test.fuzz.ts", "rotest", Buffer.from("new data")),
          ).toThrow(/EACCES/);
        } finally {
          // Restore permissions so cleanup can remove the directory
          chmodSync(corpusDir, 0o755);
        }
      },
    );

    it("round-trips: write then load returns same data", () => {
      const data = Buffer.from("round trip test");
      writeCorpusEntry("test.fuzz.ts", "parse", data);

      const loaded = loadCachedCorpus("test.fuzz.ts", "parse");
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(data);
    });
  });

  describe("writeArtifact", () => {
    it("writes a crash artifact with crash- prefix", () => {
      const data = Buffer.from("crash input");
      const filePath = writeArtifact("test.fuzz.ts", "parse", data);

      expect(path.basename(filePath)).toMatch(/^crash-[0-9a-f]{64}$/);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(data);
    });

    it("creates directories on demand", () => {
      const nestedDir = path.join(tmpDir, "deeply", "nested");
      setDataDir(nestedDir);
      const data = Buffer.from("crash");
      const filePath = writeArtifact("test.fuzz.ts", "test", data);

      expect(existsSync(filePath)).toBe(true);
    });

    it("is idempotent - duplicate writes do not overwrite", () => {
      const data = Buffer.from("same crash");
      const path1 = writeArtifact("test.fuzz.ts", "parse", data);
      const path2 = writeArtifact("test.fuzz.ts", "parse", data);

      expect(path1).toBe(path2);
    });

    it("writes crash artifact to crashes subdirectory", () => {
      const data = Buffer.from("crash data");
      const filePath = writeArtifact("test.fuzz.ts", "parse", data);

      const hashDir = hashTestPath("test.fuzz.ts", "parse");
      const expectedDir = path.join(tmpDir, "testdata", hashDir, "crashes");
      expect(path.dirname(filePath)).toBe(expectedDir);
    });

    it("writes a timeout artifact with timeout- prefix", () => {
      const data = Buffer.from("timeout input");
      const filePath = writeArtifact("test.fuzz.ts", "parse", data, "timeout");

      expect(path.basename(filePath)).toMatch(/^timeout-[0-9a-f]{64}$/);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(data);
    });

    it("writes timeout artifact to timeouts subdirectory", () => {
      const data = Buffer.from("timeout data");
      const filePath = writeArtifact("test.fuzz.ts", "parse", data, "timeout");

      const hashDir = hashTestPath("test.fuzz.ts", "parse");
      const expectedDir = path.join(tmpDir, "testdata", hashDir, "timeouts");
      expect(path.dirname(filePath)).toBe(expectedDir);
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

  describe("hashTestPath", () => {
    it("produces hash-slug format for simple name", () => {
      const result = hashTestPath("test.fuzz.ts", "parse-url");
      expect(result).toMatch(/^[0-9a-dfghijklmnpqrsvwxyz]{32}-parse-url$/);
    });

    it("produces different hashes for names that differ only in non-alphanumeric chars", () => {
      const a = hashTestPath("test.fuzz.ts", "parse url");
      const b = hashTestPath("test.fuzz.ts", "parse:url");
      // Both have same slug but different hashes
      expect(a).toMatch(/-parse_url$/);
      expect(b).toMatch(/-parse_url$/);
      expect(a).not.toBe(b);
    });

    it("produces hash-only for empty string", () => {
      const result = hashTestPath("test.fuzz.ts", "");
      expect(result).toMatch(/^[0-9a-dfghijklmnpqrsvwxyz]{32}$/);
    });

    it("produces hash-only for only special chars", () => {
      const result = hashTestPath("test.fuzz.ts", "///");
      expect(result).toMatch(/^[0-9a-dfghijklmnpqrsvwxyz]{32}$/);
    });

    it("produces hash-only for single dot", () => {
      const result = hashTestPath("test.fuzz.ts", ".");
      expect(result).toMatch(/^[0-9a-dfghijklmnpqrsvwxyz]{32}$/);
    });

    it("produces hash-only for double dot", () => {
      const result = hashTestPath("test.fuzz.ts", "..");
      expect(result).toMatch(/^[0-9a-dfghijklmnpqrsvwxyz]{32}$/);
    });

    it("preserves dots dashes and alphanumerics in slug", () => {
      const result = hashTestPath("test.fuzz.ts", "valid-name_1.0");
      expect(result).toMatch(
        /^[0-9a-dfghijklmnpqrsvwxyz]{32}-valid-name_1\.0$/,
      );
    });

    it("collapses runs of underscores in slug", () => {
      const result = hashTestPath("test.fuzz.ts", "a///b");
      expect(result).toMatch(/^[0-9a-dfghijklmnpqrsvwxyz]{32}-a_b$/);
    });

    it("replaces spaces in slug", () => {
      const result = hashTestPath("test.fuzz.ts", "my test name");
      expect(result).toMatch(/^[0-9a-dfghijklmnpqrsvwxyz]{32}-my_test_name$/);
    });

    it("same inputs always produce the same result (deterministic)", () => {
      expect(hashTestPath("test.fuzz.ts", "parse-url")).toBe(
        hashTestPath("test.fuzz.ts", "parse-url"),
      );
    });

    it("different file paths produce different hashes for the same test name", () => {
      const a = hashTestPath("test/url.fuzz.ts", "parse");
      const b = hashTestPath("test/json.fuzz.ts", "parse");
      expect(a).not.toBe(b);
    });
  });

  describe("file-qualified cached corpus prevents cross-file collisions", () => {
    it("same test name in different files produces distinct cache paths", () => {
      const data = Buffer.from("test data");
      const path1 = writeCorpusEntry("test/url.fuzz.ts", "parse", data);
      const path2 = writeCorpusEntry("test/json.fuzz.ts", "parse", data);

      // Same file name, different parent directories
      expect(path1).not.toBe(path2);

      // Each loads only its own entry
      const loaded1 = loadCachedCorpus("test/url.fuzz.ts", "parse");
      const loaded2 = loadCachedCorpus("test/json.fuzz.ts", "parse");
      expect(loaded1).toHaveLength(1);
      expect(loaded2).toHaveLength(1);
    });

    it("empty/degenerate names produce valid hash-only directories", () => {
      const data = Buffer.from("test data");
      const filePath = writeCorpusEntry("test.fuzz.ts", "", data);
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe("getDataDir", () => {
    afterEach(() => {
      resetDataDir();
      resetProjectRoot();
    });

    it("uses project root for default .vitiate when project root is set", () => {
      resetDataDir();
      setProjectRoot("/home/user/project");
      const dir = getDataDir();
      expect(dir).toBe(path.resolve("/home/user/project", ".vitiate"));
    });

    it("returns resolved data dir when set", () => {
      setDataDir(path.resolve("/home/user/project", ".my-data"));
      setProjectRoot("/home/user/project");
      const dir = getDataDir();
      expect(dir).toBe(path.resolve("/home/user/project", ".my-data"));
    });

    it("returns absolute data dir as-is", () => {
      setDataDir("/absolute/path");
      setProjectRoot("/home/user/project");
      const dir = getDataDir();
      expect(dir).toBe("/absolute/path");
    });

    it("falls back to cwd when no project root is set", () => {
      resetDataDir();
      const dir = getDataDir();
      expect(dir).toBe(path.resolve(process.cwd(), ".vitiate"));
    });

    it("returns an absolute path in all cases", () => {
      resetDataDir();
      expect(path.isAbsolute(getDataDir())).toBe(true);
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
      const result = loadCachedCorpusWithPaths("test.fuzz.ts", "nonexistent");
      expect(result).toEqual([]);
    });

    it("returns entries with absolute paths and data", () => {
      const hashDir = hashTestPath("test.fuzz.ts", "parse");
      const dir = path.join(tmpDir, "corpus", hashDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "a1b2c3d4"), "data1");
      writeFileSync(path.join(dir, "e5f6g7h8"), "data2");

      const result = loadCachedCorpusWithPaths("test.fuzz.ts", "parse");
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

  describe("discoverDictionaries", () => {
    it("returns paths when .dict files exist", () => {
      const hashDir = hashTestPath("test.fuzz.ts", "parse-json");
      const testDataDir = path.join(tmpDir, "testdata", hashDir);
      mkdirSync(testDataDir, { recursive: true });
      const dictPath = path.join(testDataDir, "keywords.dict");
      writeFileSync(dictPath, '"true"\n"false"\n');

      const result = discoverDictionaries("test.fuzz.ts", "parse-json");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(path.resolve(dictPath));
    });

    it("returns empty array when no dictionary files exist", () => {
      const result = discoverDictionaries("test.fuzz.ts", "nonexistent-test");
      expect(result).toEqual([]);
    });

    it("discovers file named 'dictionary'", () => {
      const hashDir = hashTestPath("test.fuzz.ts", "my-test");
      const testDataDir = path.join(tmpDir, "testdata", hashDir);
      mkdirSync(testDataDir, { recursive: true });
      const dictPath = path.join(testDataDir, "dictionary");
      writeFileSync(dictPath, '"keyword"\n');

      const result = discoverDictionaries("test.fuzz.ts", "my-test");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(path.resolve(dictPath));
    });

    it("does not confuse seed corpus subdirectory with dictionary file", () => {
      const hashDir = hashTestPath("test.fuzz.ts", "my-test");
      const seedDir = path.join(tmpDir, "testdata", hashDir, "seeds");
      mkdirSync(seedDir, { recursive: true });
      writeFileSync(path.join(seedDir, "seed1"), "data");
      // No .dict file - only the seeds subdirectory exists.

      const result = discoverDictionaries("test.fuzz.ts", "my-test");
      expect(result).toEqual([]);
    });
  });

  describe("loadTestDataCorpus", () => {
    it("returns empty array when testdata directory does not exist", () => {
      const result = loadTestDataCorpus("test.fuzz.ts", "nonexistent");
      expect(result).toEqual([]);
    });

    it("loads from seeds, crashes, and timeouts subdirectories", () => {
      const hashDir = hashTestPath("test.fuzz.ts", "parse");
      const testDataDir = path.join(tmpDir, "testdata", hashDir);
      const seedDir = path.join(testDataDir, "seeds");
      const crashDir = path.join(testDataDir, "crashes");
      const timeoutDir = path.join(testDataDir, "timeouts");
      mkdirSync(seedDir, { recursive: true });
      mkdirSync(crashDir, { recursive: true });
      mkdirSync(timeoutDir, { recursive: true });
      writeFileSync(path.join(seedDir, "seed1"), "seed data");
      writeFileSync(path.join(crashDir, "crash-abc"), "crash data");
      writeFileSync(path.join(timeoutDir, "timeout-def"), "timeout data");

      const result = loadTestDataCorpus("test.fuzz.ts", "parse");
      expect(result).toHaveLength(3);
      const contents = result.map((b) => b.toString()).sort();
      expect(contents).toEqual(["crash data", "seed data", "timeout data"]);
    });

    it("handles missing subdirectories gracefully", () => {
      const hashDir = hashTestPath("test.fuzz.ts", "parse");
      const testDataDir = path.join(tmpDir, "testdata", hashDir);
      const seedDir = path.join(testDataDir, "seeds");
      mkdirSync(seedDir, { recursive: true });
      writeFileSync(path.join(seedDir, "seed1"), "seed only");

      const result = loadTestDataCorpus("test.fuzz.ts", "parse");
      expect(result).toHaveLength(1);
      expect(result[0]!.toString()).toBe("seed only");
    });
  });

  describe("getTestDataDir", () => {
    it("returns path under dataDir/testdata/<hashdir>", () => {
      const result = getTestDataDir("test.fuzz.ts", "parse");
      const hashDir = hashTestPath("test.fuzz.ts", "parse");
      expect(result).toBe(path.join(tmpDir, "testdata", hashDir));
    });
  });

  describe("getCorpusDir", () => {
    it("returns path under dataDir/corpus/<hashdir>", () => {
      const result = getCorpusDir("test.fuzz.ts", "parse");
      const hashDir = hashTestPath("test.fuzz.ts", "parse");
      expect(result).toBe(path.join(tmpDir, "corpus", hashDir));
    });
  });
});
