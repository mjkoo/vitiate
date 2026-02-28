import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  loadSeedCorpus,
  loadCachedCorpus,
  writeCorpusEntry,
  writeCrashArtifact,
  sanitizeTestName,
  getCacheDir,
  loadCorpusFromDirs,
} from "./corpus.js";

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
      const dir = path.join(tmpDir, "testdata", "fuzz", "empty");
      mkdirSync(dir, { recursive: true });
      const result = loadSeedCorpus(tmpDir, "empty");
      expect(result).toEqual([]);
    });

    it("loads all files from seed corpus directory", () => {
      const dir = path.join(tmpDir, "testdata", "fuzz", "parse");
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
      const dir = path.join(tmpDir, "testdata", "fuzz", "withsubdir");
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
      const result = loadCachedCorpus(tmpDir, "nonexistent");
      expect(result).toEqual([]);
    });

    it("loads all files from cached corpus directory", () => {
      const dir = path.join(tmpDir, "parse");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "a1b2c3d4"), "data1");
      writeFileSync(path.join(dir, "e5f6g7h8"), "data2");

      const result = loadCachedCorpus(tmpDir, "parse");
      expect(result).toHaveLength(2);
    });

    it("skips subdirectories in cached corpus", () => {
      const dir = path.join(tmpDir, "withsubdir");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "a1b2c3d4"), "data1");
      mkdirSync(path.join(dir, "subdir"), { recursive: true });
      writeFileSync(path.join(dir, "subdir", "nested"), "should be ignored");

      const result = loadCachedCorpus(tmpDir, "withsubdir");
      expect(result).toHaveLength(1);
      expect(result[0]!.toString()).toBe("data1");
    });
  });

  describe("writeCorpusEntry", () => {
    it("writes a corpus entry and returns the path", () => {
      const data = Buffer.from("interesting input");
      const filePath = writeCorpusEntry(tmpDir, "parse", data);

      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(data);
    });

    it("creates directories on demand", () => {
      const cacheDir = path.join(tmpDir, "deeply", "nested");
      const data = Buffer.from("data");
      const filePath = writeCorpusEntry(cacheDir, "test", data);

      expect(existsSync(filePath)).toBe(true);
    });

    it("is idempotent - duplicate writes do not overwrite", () => {
      const data = Buffer.from("same input");
      const path1 = writeCorpusEntry(tmpDir, "parse", data);
      const path2 = writeCorpusEntry(tmpDir, "parse", data);

      expect(path1).toBe(path2);
    });

    it("round-trips: write then load returns same data", () => {
      const data = Buffer.from("round trip test");
      writeCorpusEntry(tmpDir, "parse", data);

      const loaded = loadCachedCorpus(tmpDir, "parse");
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(data);
    });
  });

  describe("writeCrashArtifact", () => {
    it("writes a crash artifact with crash- prefix", () => {
      const data = Buffer.from("crash input");
      const filePath = writeCrashArtifact(tmpDir, "parse", data);

      expect(path.basename(filePath)).toMatch(/^crash-[0-9a-f]{16}$/);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath)).toEqual(data);
    });

    it("creates directories on demand", () => {
      const testDir = path.join(tmpDir, "deeply", "nested");
      const data = Buffer.from("crash");
      const filePath = writeCrashArtifact(testDir, "test", data);

      expect(existsSync(filePath)).toBe(true);
    });

    it("is idempotent - duplicate writes do not overwrite", () => {
      const data = Buffer.from("same crash");
      const path1 = writeCrashArtifact(tmpDir, "parse", data);
      const path2 = writeCrashArtifact(tmpDir, "parse", data);

      expect(path1).toBe(path2);
    });

    it("round-trips: crash artifact can be loaded as seed corpus", () => {
      const data = Buffer.from("crash round trip");
      writeCrashArtifact(tmpDir, "parse", data);

      const loaded = loadSeedCorpus(tmpDir, "parse");
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(data);
    });
  });

  describe("sanitizeTestName", () => {
    it("replaces slashes with underscores", () => {
      expect(sanitizeTestName("a/b/c")).toBe("a_b_c");
    });

    it("replaces path separators but preserves dots", () => {
      expect(sanitizeTestName("../../../etc/passwd")).toBe(
        ".._.._.._etc_passwd",
      );
    });

    it("collapses runs of underscores", () => {
      expect(sanitizeTestName("a///b")).toBe("a_b");
    });

    it("replaces spaces", () => {
      expect(sanitizeTestName("my test name")).toBe("my_test_name");
    });

    it("returns unnamed for empty string", () => {
      expect(sanitizeTestName("")).toBe("unnamed");
    });

    it("returns unnamed for only special chars", () => {
      expect(sanitizeTestName("///")).toBe("unnamed");
    });

    it("preserves dots dashes and alphanumerics", () => {
      expect(sanitizeTestName("valid-name_1.0")).toBe("valid-name_1.0");
    });

    it("returns unnamed for single dot", () => {
      expect(sanitizeTestName(".")).toBe("unnamed");
    });

    it("returns unnamed for double dot", () => {
      expect(sanitizeTestName("..")).toBe("unnamed");
    });
  });

  describe("getCacheDir", () => {
    const originalCacheDir = process.env["VITIATE_CACHE_DIR"];
    const originalProjectRoot = process.env["VITIATE_PROJECT_ROOT"];

    afterEach(() => {
      if (originalCacheDir === undefined) {
        delete process.env["VITIATE_CACHE_DIR"];
      } else {
        process.env["VITIATE_CACHE_DIR"] = originalCacheDir;
      }
      if (originalProjectRoot === undefined) {
        delete process.env["VITIATE_PROJECT_ROOT"];
      } else {
        process.env["VITIATE_PROJECT_ROOT"] = originalProjectRoot;
      }
    });

    it("uses project root for default .vitiate-corpus when VITIATE_PROJECT_ROOT is set", () => {
      delete process.env["VITIATE_CACHE_DIR"];
      process.env["VITIATE_PROJECT_ROOT"] = "/home/user/project";
      const dir = getCacheDir();
      expect(dir).toBe("/home/user/project/.vitiate-corpus");
    });

    it("resolves relative VITIATE_CACHE_DIR against project root", () => {
      process.env["VITIATE_CACHE_DIR"] = ".my-corpus";
      process.env["VITIATE_PROJECT_ROOT"] = "/home/user/project";
      const dir = getCacheDir();
      expect(dir).toBe("/home/user/project/.my-corpus");
    });

    it("returns absolute VITIATE_CACHE_DIR as-is", () => {
      process.env["VITIATE_CACHE_DIR"] = "/absolute/path";
      process.env["VITIATE_PROJECT_ROOT"] = "/home/user/project";
      const dir = getCacheDir();
      expect(dir).toBe("/absolute/path");
    });

    it("falls back to cwd when no project root is set", () => {
      delete process.env["VITIATE_CACHE_DIR"];
      delete process.env["VITIATE_PROJECT_ROOT"];
      const dir = getCacheDir();
      expect(dir).toBe(path.resolve(process.cwd(), ".vitiate-corpus"));
    });

    it("resolves relative VITIATE_CACHE_DIR against cwd when no project root", () => {
      process.env["VITIATE_CACHE_DIR"] = "relative/path";
      delete process.env["VITIATE_PROJECT_ROOT"];
      const dir = getCacheDir();
      expect(dir).toBe(path.resolve(process.cwd(), "relative/path"));
    });

    it("returns an absolute path in all cases", () => {
      delete process.env["VITIATE_CACHE_DIR"];
      delete process.env["VITIATE_PROJECT_ROOT"];
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
});
