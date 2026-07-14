// Shared runner for the per-library CJS fuzz benchmarks (benchmarks/<lib>/).
//
// Invoked from a benchmark package directory (its `bench` script runs
// `node ../run-lib.mjs`), so the current working directory IS the package.
// It fuzzes that package's single fuzz target from a clean state (committed
// seeds only, evolved corpus wiped) for a fixed wall-clock budget and reports
// coverage/throughput from the authoritative results file.
//
// Usage: node ../run-lib.mjs [--duration <sec>] [--runs <n>]

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url)); // benchmarks/
const ROOT = path.resolve(RUNNER_DIR, "..");
const PKG = process.cwd(); // the benchmark package invoking the runner

function fail(msg) {
  process.stderr.write(`bench: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { duration: 30, runs: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--")
      continue; // conventional separator (pnpm run passes it through)
    else if (a === "--duration") opts.duration = Number(argv[++i]);
    else if (a === "--runs") opts.runs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node ../run-lib.mjs [--duration <sec>] [--runs <n>]\n",
      );
      process.exit(0);
    } else fail(`unknown arg: ${a}`);
  }
  if (!Number.isInteger(opts.duration) || opts.duration <= 0) {
    fail("--duration must be a positive integer (seconds)");
  }
  if (!Number.isInteger(opts.runs) || opts.runs <= 0) {
    fail("--runs must be a positive integer");
  }
  return opts;
}

/** Run a workspace binary via `pnpm exec` from the package dir, capturing output. */
function pexec(args) {
  return spawnSync("pnpm", ["exec", ...args], { cwd: PKG, encoding: "utf-8" });
}

/** Human-readable reason a captured spawn failed (stderr, stdout, or spawn error). */
function spawnFailure(result) {
  return (
    (result.stderr && result.stderr.trim()) ||
    (result.stdout && result.stdout.trim()) ||
    result.error?.message ||
    `exit ${result.status}`
  );
}

/** The package's single fuzz test (with its testdata/corpus paths). */
function singleTest() {
  const r = pexec(["vitiate", "paths", "--json"]);
  if (r.status !== 0) fail(`vitiate paths --json failed: ${spawnFailure(r)}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    fail(`could not parse vitiate paths --json output: ${err.message}`);
  }
  const tests = parsed.tests ?? [];
  if (tests.length !== 1) {
    fail(`expected exactly one fuzz test in ${PKG}, found ${tests.length}`);
  }
  return tests[0];
}

/** Copy the committed seeds into the test's testdata seeds dir. */
function seed(entry) {
  const seedSrc = path.join(PKG, "seeds");
  if (!existsSync(seedSrc)) return 0;
  const seedsDir = path.join(entry.testDataDir, "seeds");
  mkdirSync(seedsDir, { recursive: true });
  let n = 0;
  for (const f of readdirSync(seedSrc)) {
    copyFileSync(path.join(seedSrc, f), path.join(seedsDir, f));
    n++;
  }
  return n;
}

/**
 * Remove the evolved corpus and any prior findings so a run starts from the
 * committed seeds only. vitiate reloads seeds + crashes + timeouts + cached
 * corpus on start, so without this each run (and each rerun) would begin warm,
 * making coverage/throughput a function of hidden history rather than the budget.
 */
function resetToSeeds(entry) {
  rmSync(entry.corpusDir, { recursive: true, force: true });
  for (const sub of ["crashes", "timeouts", "ooms"]) {
    rmSync(path.join(entry.testDataDir, sub), { recursive: true, force: true });
  }
}

/** Fuzz the target file for `durationSec` and return its metrics (or invalid). */
function runOne(file, durationSec) {
  const dir = mkdtempSync(path.join(tmpdir(), "bench-"));
  try {
    const resultsFile = path.join(dir, "results.json");
    const result = spawnSync("pnpm", ["exec", "vitest", "run", file], {
      cwd: PKG,
      env: {
        ...process.env,
        VITIATE_FUZZ: "1",
        VITIATE_FUZZ_TIME: String(durationSec),
        VITIATE_RESULTS_FILE: resultsFile,
        NO_COLOR: "1",
      },
      stdio: "inherit",
      timeout: (durationSec + 45) * 1000,
    });
    // Exit 0 = clean, 1 = crash found; both valid. Anything else (or a killed
    // timeout, status === null) is invalid.
    const validExit = result.status === 0 || result.status === 1;
    if (!existsSync(resultsFile)) {
      const why = result.error?.message ?? `exit ${result.status}`;
      return { invalid: true, reason: `no results file (${why})` };
    }
    let data;
    try {
      data = JSON.parse(readFileSync(resultsFile, "utf-8"));
    } catch (err) {
      return { invalid: true, reason: `unreadable results (${err.message})` };
    }
    return {
      invalid: !validExit,
      reason: validExit ? "" : `unexpected exit ${result.status}`,
      edges: data.coverageEdges ?? 0,
      features: data.coverageFeatures ?? 0,
      execsPerSec: data.execsPerSec ?? 0,
      corpus: data.corpusSize ?? 0,
      crashes: data.crashCount ?? 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const opts = parseArgs(process.argv.slice(2));

if (!existsSync(path.join(ROOT, "vitiate-core", "dist", "index.js"))) {
  fail(
    "vitiate-core/dist not found - run `pnpm build` at the repo root first.",
  );
}

const init = pexec(["vitiate", "init"]);
if (init.status !== 0) fail(`vitiate init failed: ${spawnFailure(init)}`);

const entry = singleTest();
process.stdout.write(
  `bench: ${entry.name}\nbench: seeded ${seed(entry)} files\n`,
);

const valid = [];
let anyInvalid = false;
for (let i = 0; i < opts.runs; i++) {
  resetToSeeds(entry); // every run starts from the committed seeds only
  process.stdout.write(
    `\nbench: fuzzing for ${opts.duration}s (run ${i + 1}/${opts.runs}, clean corpus)...\n`,
  );
  const res = runOne(entry.file, opts.duration);
  if (res.invalid) {
    anyInvalid = true;
    process.stderr.write(`bench: INVALID run: ${res.reason}\n`);
  } else {
    valid.push(res);
  }
}

process.stdout.write(`\n=== ${entry.name} (vitiate) ===\n`);
process.stdout.write(
  `edges=${median(valid.map((r) => r.edges))} ` +
    `features=${median(valid.map((r) => r.features))} ` +
    `execs/sec=${Math.round(median(valid.map((r) => r.execsPerSec)))} ` +
    `corpus=${median(valid.map((r) => r.corpus))} ` +
    `crashes=${median(valid.map((r) => r.crashes))}\n`,
);

if (anyInvalid) {
  process.stderr.write("\nbench: one or more runs were INVALID\n");
  process.exit(1);
}
