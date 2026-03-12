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
import { getDataDir } from "./config.js";
import { hashTestPath } from "./nix-base32.js";

function contentHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
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

/**
 * Return the testdata directory for a fuzz test under the global data root.
 * Path: `<dataDir>/testdata/<hashdir>`
 */
export function getTestDataDir(
  relativeTestFilePath: string,
  testName: string,
): string {
  return path.join(
    getDataDir(),
    "testdata",
    hashTestPath(relativeTestFilePath, testName),
  );
}

/**
 * Return the corpus cache directory for a fuzz test under the global data root.
 * Path: `<dataDir>/corpus/<hashdir>`
 */
export function getCorpusDir(
  relativeTestFilePath: string,
  testName: string,
): string {
  return path.join(
    getDataDir(),
    "corpus",
    hashTestPath(relativeTestFilePath, testName),
  );
}

/**
 * Discover dictionary files for a fuzz test by scanning the testdata directory.
 * Looks for `*.dict` files and a file named `dictionary` at the top level.
 * Files inside subdirectories (seeds/, crashes/, timeouts/) are ignored.
 * Returns resolved paths, or an empty array if none found.
 */
export function discoverDictionaries(
  relativeTestFilePath: string,
  testName: string,
): string[] {
  const testDataDir = getTestDataDir(relativeTestFilePath, testName);
  if (!existsSync(testDataDir)) {
    return [];
  }

  const paths: string[] = [];
  const entries = readdirSync(testDataDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".dict") || entry.name === "dictionary") {
      paths.push(path.resolve(path.join(testDataDir, entry.name)));
    }
  }
  return paths.sort();
}

/**
 * Load all testdata entries (seeds + crashes + timeouts) for regression and seeding.
 * Missing subdirectories are silently skipped.
 */
export function loadTestDataCorpus(
  relativeTestFilePath: string,
  testName: string,
): Buffer[] {
  const testDataDir = getTestDataDir(relativeTestFilePath, testName);
  const subdirs = ["seeds", "crashes", "timeouts"];
  return subdirs.flatMap((sub) => readCorpusDir(path.join(testDataDir, sub)));
}

/**
 * Load cached corpus from `<dataDir>/corpus/<hashdir>/`.
 */
export function loadCachedCorpus(
  relativeTestFilePath: string,
  testName: string,
): Buffer[] {
  const dir = getCorpusDir(relativeTestFilePath, testName);
  return readCorpusDir(dir);
}

/**
 * Load cached corpus with file paths from `<dataDir>/corpus/<hashdir>/`.
 */
export function loadCachedCorpusWithPaths(
  relativeTestFilePath: string,
  testName: string,
): CorpusEntryWithPath[] {
  const dir = getCorpusDir(relativeTestFilePath, testName);
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
 * Write a cached corpus entry to `<dataDir>/corpus/<hashdir>/<contenthash>`.
 */
export function writeCorpusEntry(
  relativeTestFilePath: string,
  testName: string,
  data: Buffer,
): string {
  const dir = getCorpusDir(relativeTestFilePath, testName);
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

/**
 * Write a crash or timeout artifact to the testdata directory.
 * Crashes go to `<dataDir>/testdata/<hashdir>/crashes/crash-<contenthash>`.
 * Timeouts go to `<dataDir>/testdata/<hashdir>/timeouts/timeout-<contenthash>`.
 */
export function writeArtifact(
  relativeTestFilePath: string,
  testName: string,
  data: Buffer,
  kind: ArtifactKind = "crash",
): string {
  const testDataDir = getTestDataDir(relativeTestFilePath, testName);
  const subdir = kind === "timeout" ? "timeouts" : "crashes";
  const dir = path.join(testDataDir, subdir);
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
      // Best-effort cleanup - temp file may already be gone
    }
    throw new Error(`Failed to replace artifact ${tmpPath} -> ${newPath}`, {
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
