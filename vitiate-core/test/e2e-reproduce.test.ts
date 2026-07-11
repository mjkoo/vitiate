/**
 * End-to-end tests for the `vitiate reproduce` subcommand.
 *
 * Unlike the fuzz-pipeline e2e (which relies on the fuzzer discovering a
 * planted bug within a time budget), these are fully deterministic: we hand
 * `reproduce` a known crashing input (the planted port-0 bug in the url-parser
 * example) and a known-benign input, and assert the libFuzzer-style exit codes
 * (77 on a reproduced crash, 0 on a clean replay, 1 for a missing file).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

const EXAMPLE_DIR = path.resolve(TEST_DIR, "../../examples/url-parser");

/** The built CLI entry point (e2e runs post-build). */
const CLI_PATH = path.resolve(TEST_DIR, "../dist/cli.js");

interface SubprocessResult {
  exitCode: number;
  output: string;
}

/** Run `vitiate reproduce ...args` in the example project and capture output. */
function runReproduce(args: string[]): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(process.execPath, [CLI_PATH, "reproduce", ...args], {
      cwd: EXAMPLE_DIR,
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString(),
      }),
    );
    child.on("error", reject);
  });
}

/** Log subprocess output to stderr for diagnostic visibility. */
function dumpOutput(label: string, output: string): void {
  if (output.length > 0) {
    process.stderr.write(`\n── ${label} subprocess output ──\n${output}\n`);
  }
}

describe("reproduce subcommand: single-input replay with libFuzzer exit codes", () => {
  let tmpDir: string;
  let crashFile: string;
  let benignFile: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vitiate-reproduce-"));
    // The url-parser `parse-url` target throws a plain Error on port 0.
    crashFile = path.join(tmpDir, "crash.bin");
    benignFile = path.join(tmpDir, "benign.bin");
    writeFileSync(crashFile, "http://host:0/");
    writeFileSync(benignFile, "http://host:8080/path");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 77 when the input reproduces a crash", async () => {
    const result = await runReproduce([crashFile, "-test", "parse-url"]);
    if (result.exitCode !== 77) dumpOutput("reproduce-crash", result.output);
    expect(result.exitCode).toBe(77);
  }, 120_000);

  it("exits 0 when the input replays cleanly", async () => {
    const result = await runReproduce([benignFile, "-test", "parse-url"]);
    if (result.exitCode !== 0) dumpOutput("reproduce-benign", result.output);
    expect(result.exitCode).toBe(0);
  }, 120_000);

  it("exits 0 on a clean replay with the watchdog disabled (-timeout 0)", async () => {
    const result = await runReproduce([
      benignFile,
      "-test",
      "parse-url",
      "-timeout",
      "0",
    ]);
    if (result.exitCode !== 0) dumpOutput("reproduce-timeout-0", result.output);
    expect(result.exitCode).toBe(0);
  }, 120_000);

  it("exits 1 with a not-found message when the input file is missing", async () => {
    const missing = path.join(tmpDir, "does-not-exist.bin");
    const result = await runReproduce([missing, "-test", "parse-url"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("input file not found");
  }, 60_000);
});
