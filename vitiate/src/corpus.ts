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
} from "node:fs";
import path from "node:path";

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

function readCorpusDir(dir: string): Buffer[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => readFileSync(path.join(dir, e.name)));
}

export function getFuzzTestDataDir(testDir: string, testName: string): string {
  return path.join(testDir, "testdata", "fuzz", sanitizeTestName(testName));
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
  return readCorpusDir(dir);
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
  return dirs.flatMap((dir) => readCorpusDir(dir));
}

export function writeCorpusEntry(
  cacheDir: string,
  testFilePath: string,
  testName: string,
  data: Buffer,
): string {
  const dir = path.join(cacheDir, testFilePath, sanitizeTestName(testName));
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

function writeExclusive(filePath: string, data: Buffer): void {
  try {
    writeFileSync(filePath, data, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw e;
    }
  }
}
