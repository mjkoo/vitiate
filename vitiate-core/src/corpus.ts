/**
 * Corpus management: load seed/cached corpus, write entries and crash artifacts.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { getProjectRoot, getResolvedCacheDir } from "./config.js";

function contentHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sanitizeTestName(name: string): string {
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  const slug = name
    .replace(/[^a-zA-Z0-9\-_.]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (!slug || slug === "." || slug === "..") {
    return hash;
  }
  return `${hash}-${slug}`;
}

export interface CorpusEntryWithPath {
  path: string;
  data: Buffer;
}

function readCorpusDir(dir: string): Buffer[] {
  return readCorpusDirWithPaths(dir).map((e) => e.data);
}

function readCorpusDirWithPaths(dir: string): CorpusEntryWithPath[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => ({
      path: path.join(dir, e.name),
      data: readFileSync(path.join(dir, e.name)),
    }));
}

export function getFuzzTestDataDir(testDir: string, testName: string): string {
  return path.join(testDir, "testdata", "fuzz", sanitizeTestName(testName));
}

export function getDictionaryPath(
  testDir: string,
  testName: string,
): string | undefined {
  const dictPath = path.join(
    testDir,
    "testdata",
    "fuzz",
    `${sanitizeTestName(testName)}.dict`,
  );
  return existsSync(dictPath) ? path.resolve(dictPath) : undefined;
}

export function loadSeedCorpus(testDir: string, testName: string): Buffer[] {
  return readCorpusDir(getFuzzTestDataDir(testDir, testName));
}

export function loadCachedCorpus(
  cacheDir: string,
  testFilePath: string,
  testName: string,
): Buffer[] {
  const dir = path.join(cacheDir, testFilePath, sanitizeTestName(testName));
  validateCacheSubpath(cacheDir, dir);
  return readCorpusDir(dir);
}

export function getCacheDir(): string {
  const cacheDir = getResolvedCacheDir();

  if (cacheDir) {
    return cacheDir;
  }

  // Default: .vitiate-corpus relative to project root (if set) or cwd
  return path.resolve(getProjectRoot(), ".vitiate-corpus");
}

export function loadCachedCorpusWithPaths(
  cacheDir: string,
  testFilePath: string,
  testName: string,
): CorpusEntryWithPath[] {
  const dir = path.join(cacheDir, testFilePath, sanitizeTestName(testName));
  validateCacheSubpath(cacheDir, dir);
  return readCorpusDirWithPaths(dir);
}

export function loadCorpusFromDirs(dirs: string[]): Buffer[] {
  return dirs.flatMap((dir) => readCorpusDir(dir));
}

export function loadCorpusDirsWithPaths(dirs: string[]): CorpusEntryWithPath[] {
  return dirs.flatMap((dir) => readCorpusDirWithPaths(dir));
}

export function deleteCorpusEntry(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
}

/**
 * Validate that a resolved directory stays within the cache directory.
 * Prevents path traversal via `../` in testFilePath.
 */
function validateCacheSubpath(cacheDir: string, dir: string): void {
  const resolvedDir = path.resolve(dir);
  const resolvedCacheDir = path.resolve(cacheDir);
  if (
    !resolvedDir.startsWith(resolvedCacheDir + path.sep) &&
    resolvedDir !== resolvedCacheDir
  ) {
    throw new Error(
      `Cache path escapes cache directory: ${resolvedDir} is not within ${resolvedCacheDir}`,
    );
  }
}

export function writeCorpusEntry(
  cacheDir: string,
  testFilePath: string,
  testName: string,
  data: Buffer,
): string {
  const dir = path.join(cacheDir, testFilePath, sanitizeTestName(testName));
  validateCacheSubpath(cacheDir, dir);
  mkdirSync(dir, { recursive: true });
  const hash = contentHash(data);
  const filePath = path.join(dir, hash);
  writeExclusive(filePath, data);
  return filePath;
}

export function writeCorpusEntryToDir(dir: string, data: Buffer): string {
  mkdirSync(dir, { recursive: true });
  const hash = contentHash(data);
  const filePath = path.join(dir, hash);
  writeExclusive(filePath, data);
  return filePath;
}

export type ArtifactKind = "crash" | "timeout";

export function writeArtifact(
  testDir: string,
  testName: string,
  data: Buffer,
  kind: ArtifactKind = "crash",
): string {
  const dir = getFuzzTestDataDir(testDir, testName);
  mkdirSync(dir, { recursive: true });
  const hash = contentHash(data);
  const fileName = `${kind}-${hash}`;
  const filePath = path.join(dir, fileName);
  writeExclusive(filePath, data);
  return filePath;
}

export function writeArtifactWithPrefix(
  prefix: string,
  data: Buffer,
  kind: ArtifactKind = "crash",
): string {
  const hash = contentHash(data);
  const filePath = `${prefix}${kind}-${hash}`;
  const parentDir = path.dirname(filePath);
  if (parentDir !== ".") {
    mkdirSync(parentDir, { recursive: true });
  }
  writeExclusive(filePath, data);
  return filePath;
}

/**
 * Atomically replace an existing artifact with new data.
 * Writes to a temp file, renames into place, and deletes the old file
 * if the path changed. Returns the new artifact path.
 */
export function replaceArtifact(
  oldPath: string,
  newData: Buffer,
  kind: ArtifactKind,
): string {
  const hash = contentHash(newData);
  const dir = path.dirname(oldPath);
  const newFileName = `${kind}-${hash}`;
  const newPath = path.join(dir, newFileName);

  // Write to temp file in same directory (ensures same-filesystem rename)
  const tmpPath = path.join(dir, `.tmp-${newFileName}-${randomUUID()}`);
  writeFileSync(tmpPath, newData);

  // Atomic rename into place. Clean up temp file on failure to avoid
  // orphaned files from rename errors (e.g., cross-device, permissions).
  try {
    renameSync(tmpPath, newPath);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup — temp file may already be gone
    }
    throw new Error(`Failed to replace artifact ${tmpPath} → ${newPath}`, {
      cause: e,
    });
  }

  // Delete old file if path differs
  if (newPath !== oldPath) {
    try {
      unlinkSync(oldPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
  }

  return newPath;
}

function writeExclusive(filePath: string, data: Buffer): void {
  try {
    writeFileSync(filePath, data, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw e;
    }
  }
}
