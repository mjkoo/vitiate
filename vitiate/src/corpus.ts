/**
 * Corpus management: load seed/cached corpus, write entries and crash artifacts.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  type WriteFileOptions,
} from "node:fs";
import path from "node:path";

function contentHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export function sanitizeTestName(name: string): string {
  const sanitized = name
    .replace(/[^a-zA-Z0-9\-_.]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "unnamed";
  }
  return sanitized;
}

export function loadSeedCorpus(testDir: string, testName: string): Buffer[] {
  const dir = path.join(
    testDir,
    "testdata",
    "fuzz",
    sanitizeTestName(testName),
  );
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => readFileSync(path.join(dir, e.name)));
}

export function loadCachedCorpus(cacheDir: string, testName: string): Buffer[] {
  const dir = path.join(cacheDir, sanitizeTestName(testName));
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => readFileSync(path.join(dir, e.name)));
}

export function getCacheDir(): string {
  return path.resolve(process.env["VITIATE_CACHE_DIR"] ?? ".vitiate-corpus");
}

export function loadCorpusFromDirs(dirs: string[]): Buffer[] {
  const entries: Buffer[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir, { withFileTypes: true });
    for (const f of files) {
      if (f.isFile()) {
        entries.push(readFileSync(path.join(dir, f.name)));
      }
    }
  }
  return entries;
}

export function writeCorpusEntry(
  cacheDir: string,
  testName: string,
  data: Buffer,
): string {
  const dir = path.join(cacheDir, sanitizeTestName(testName));
  mkdirSync(dir, { recursive: true });
  const hash = contentHash(data);
  const filePath = path.join(dir, hash);
  writeExclusive(filePath, data);
  return filePath;
}

export function writeCrashArtifact(
  testDir: string,
  testName: string,
  data: Buffer,
): string {
  const dir = path.join(
    testDir,
    "testdata",
    "fuzz",
    sanitizeTestName(testName),
  );
  mkdirSync(dir, { recursive: true });
  const hash = contentHash(data);
  const fileName = `crash-${hash}`;
  const filePath = path.join(dir, fileName);
  writeExclusive(filePath, data);
  return filePath;
}

function writeExclusive(filePath: string, data: Buffer): void {
  try {
    writeFileSync(filePath, data, { flag: "wx" } as WriteFileOptions);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw e;
    }
  }
}
