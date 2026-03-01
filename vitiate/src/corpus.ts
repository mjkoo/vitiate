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

export function getFuzzTestDataDir(testDir: string, testName: string): string {
  return path.join(testDir, "testdata", "fuzz", sanitizeTestName(testName));
}

export function loadSeedCorpus(testDir: string, testName: string): Buffer[] {
  const dir = getFuzzTestDataDir(testDir, testName);
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
  const cacheDir = process.env["VITIATE_CACHE_DIR"];
  const projectRoot = process.env["VITIATE_PROJECT_ROOT"];

  if (cacheDir) {
    // If absolute, use as-is; if relative, resolve against project root or cwd
    if (path.isAbsolute(cacheDir)) {
      return cacheDir;
    }
    return path.resolve(projectRoot ?? process.cwd(), cacheDir);
  }

  // Default: .vitiate-corpus relative to project root (if set) or cwd
  return path.resolve(projectRoot ?? process.cwd(), ".vitiate-corpus");
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
  const dir = getFuzzTestDataDir(testDir, testName);
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
