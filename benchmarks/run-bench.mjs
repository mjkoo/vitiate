#!/usr/bin/env node

/**
 * Benchmark runner: drive both harness checkouts' own fuzz-benchmark.js
 * scripts, then merge their JSONL outputs into a dated comparison report.
 *
 * Each harness script runs the 5 xword-parser targets (ipuz, puz, jpz, xd,
 * parse) sequentially for --duration seconds x --runs runs, plus regression
 * suite timing. This orchestrator adds run validation (see validateRun) and
 * report generation; the per-fuzzer mechanics live in the vendored scripts.
 *
 * Usage:
 *   node run-bench.mjs [--mode smoke|full] [--fuzzer jazzer,vitiate]
 *                      [--duration N] [--runs N]
 *
 * Exits nonzero if any run is INVALID (died early, missing metrics, or
 * unexpected exit code) so systematic failures are loud.
 */

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH_ROOT = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(BENCH_ROOT, "vendor");
const RESULTS = join(BENCH_ROOT, "results");
const RAW = join(RESULTS, "raw");

const config = JSON.parse(
  readFileSync(join(BENCH_ROOT, "bench.config.json"), "utf-8"),
);

// Patterns that indicate an engine-level failure rather than a fuzzing
// result. The vendored scripts capture their child's stderr internally, so
// these rarely surface at this level, but scanning is cheap insurance.
const ENGINE_ERROR_RE =
  /Scheduler on_replace failed|Key not found|panicked at|FATAL ERROR/;

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let mode = "smoke";
let fuzzers = Object.keys(config.harnesses);
let durationOverride = null;
let runsOverride = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--mode" && args[i + 1]) {
    mode = args[++i];
  } else if (args[i] === "--fuzzer" && args[i + 1]) {
    fuzzers = args[++i].split(",");
  } else if (args[i] === "--duration" && args[i + 1]) {
    durationOverride = parseInt(args[++i]);
  } else if (args[i] === "--runs" && args[i + 1]) {
    runsOverride = parseInt(args[++i]);
  } else if (args[i] === "--help") {
    console.log(
      "Usage: node run-bench.mjs [--mode smoke|full] [--fuzzer jazzer,vitiate] [--duration N] [--runs N]",
    );
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${args[i]}`);
    process.exit(1);
  }
}

if (!config.modes[mode]) {
  console.error(
    `Unknown mode "${mode}" - expected one of: ${Object.keys(config.modes).join(", ")}`,
  );
  process.exit(1);
}
for (const f of fuzzers) {
  if (!config.harnesses[f]) {
    console.error(
      `Unknown fuzzer "${f}" - expected one of: ${Object.keys(config.harnesses).join(", ")}`,
    );
    process.exit(1);
  }
}

const duration = durationOverride ?? config.modes[mode].duration;
const runs = runsOverride ?? config.modes[mode].runs;

const setupMetaPath = join(VENDOR, "setup-meta.json");
if (!existsSync(setupMetaPath)) {
  console.error("vendor/setup-meta.json not found - run setup.mjs first");
  process.exit(1);
}
const setupMeta = JSON.parse(readFileSync(setupMetaPath, "utf-8"));

mkdirSync(RAW, { recursive: true });

const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");

function log(msg) {
  console.log(`[bench] ${msg}`);
}

// ── Run one harness's benchmark script ──────────────────────────────────────

function runHarness(name) {
  return new Promise((resolvePromise) => {
    const cwd = join(VENDOR, `xword-${name}`);
    const jsonlPath = join(RAW, `${stamp}-${mode}-${name}.jsonl`);
    const logPath = join(RAW, `${stamp}-${mode}-${name}.log`);
    const logStream = createWriteStream(logPath);

    log(`running ${name} harness (duration=${duration}s, runs=${runs})`);
    log(`  console log: ${logPath}`);

    const child = spawn(
      "node",
      [
        join("scripts", "fuzz-benchmark.js"),
        "--duration",
        String(duration),
        "--runs",
        String(runs),
        "--output",
        jsonlPath,
      ],
      { cwd, stdio: ["inherit", "pipe", "pipe"], shell: false },
    );

    let consoleOutput = "";
    const forward = (stream) => (data) => {
      const text = data.toString();
      consoleOutput += text;
      logStream.write(text);
      stream.write(text);
    };
    child.stdout.on("data", forward(process.stdout));
    child.stderr.on("data", forward(process.stderr));

    child.on("exit", (code) => {
      logStream.end();
      resolvePromise({
        name,
        exitCode: code,
        jsonlPath,
        logPath,
        engineErrorsInConsole: ENGINE_ERROR_RE.test(consoleOutput),
      });
    });
  });
}

// ── JSONL parsing & validation ──────────────────────────────────────────────

function parseJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Classify one fuzz_run event. Returns a list of problems; empty = valid.
 *
 * Heuristics (the vendored scripts swallow the fuzz child's stderr, so
 * engine errors can only be inferred):
 * - exit codes other than 0 (clean) or 1 (test failed = crash found) are
 *   infrastructure/engine failures;
 * - a run that produced no metrics at all never really started;
 * - a run that ended well before its time budget without finding a crash
 *   aborted (e.g. an engine error inside the fuzz loop).
 */
function validateRun(run, expectedDuration) {
  const problems = [];
  if (run.exitCode !== 0 && run.exitCode !== 1) {
    problems.push(`unexpected exit code ${run.exitCode}`);
  }
  const hasMetrics =
    run.sampleCount > 0 ||
    run.finalEdges != null ||
    run.finalCoverage != null ||
    run.finalExecs != null;
  if (!hasMetrics) {
    problems.push("no metrics captured");
  }
  const crashes = run.crashes ?? 0;
  if (run.wallTimeSec < expectedDuration * 0.75 && crashes === 0) {
    problems.push(
      `ended after ${run.wallTimeSec}s of ${expectedDuration}s with no crash - likely aborted`,
    );
  }
  return problems;
}

function mean(values) {
  const xs = values.filter((v) => v != null);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(value, digits = 0) {
  if (value == null) return "-";
  return Number(value).toFixed(digits);
}

// ── Main ────────────────────────────────────────────────────────────────────

const harnessResults = [];
for (const name of fuzzers) {
  harnessResults.push(await runHarness(name));
}

const report = {
  date: new Date().toISOString(),
  mode,
  duration,
  runs,
  setup: setupMeta,
  fuzzers: {},
  invalidRuns: [],
};

for (const hr of harnessResults) {
  const events = parseJsonl(hr.jsonlPath);
  const meta = events.find((e) => e.event === "meta") ?? null;
  const regressions = events.filter((e) => e.event === "regression");
  const fuzzRuns = events.filter((e) => e.event === "fuzz_run");

  const targets = {};
  for (const run of fuzzRuns) {
    const problems = validateRun(run, duration);
    if (problems.length) {
      report.invalidRuns.push({
        fuzzer: hr.name,
        target: run.fuzzer,
        run: run.run,
        problems,
      });
    }
    const t = (targets[run.fuzzer] ??= { runs: [] });
    t.runs.push({ ...run, problems });
  }

  for (const t of Object.values(targets)) {
    const rs = t.runs;
    t.aggregate = {
      execsPerSecMedian: mean(rs.map((r) => r.execsPerSec?.median)),
      finalExecs: mean(rs.map((r) => r.finalExecs)),
      finalCalibrationExecs: mean(rs.map((r) => r.finalCalibrationExecs)),
      // vitiate reports edges; jazzer reports libFuzzer cov. Both report ft.
      coverage: mean(rs.map((r) => r.finalEdges ?? r.finalCoverage)),
      features: mean(rs.map((r) => r.finalFeatures)),
      corpusSize: mean(rs.map((r) => r.finalCorpusSize)),
      startupLatencySec: mean(rs.map((r) => r.startupLatencySec)),
      crashes: rs.reduce((a, r) => a + (r.crashes ?? 0), 0),
    };
  }

  report.fuzzers[hr.name] = {
    exitCode: hr.exitCode,
    jsonl: hr.jsonlPath,
    log: hr.logPath,
    engineErrorsInConsole: hr.engineErrorsInConsole,
    meta,
    regressionMeanSec: mean(regressions.map((r) => r.wallTimeSec)),
    regressionRuns: regressions.length,
    targets,
  };

  if (hr.exitCode !== 0) {
    report.invalidRuns.push({
      fuzzer: hr.name,
      target: "(harness)",
      run: null,
      problems: [`harness script exited ${hr.exitCode}`],
    });
  }
  if (hr.engineErrorsInConsole) {
    report.invalidRuns.push({
      fuzzer: hr.name,
      target: "(harness)",
      run: null,
      problems: ["engine error pattern in console output"],
    });
  }
}

// ── Render markdown report ──────────────────────────────────────────────────

const targetNames = [
  ...new Set(
    Object.values(report.fuzzers).flatMap((f) => Object.keys(f.targets)),
  ),
];
const [a, b] = ["vitiate", "jazzer"].filter((n) => report.fuzzers[n]);

function aggRow(target, field, digits = 0) {
  const cells = [];
  for (const name of [a, b].filter(Boolean)) {
    cells.push(
      fmt(report.fuzzers[name]?.targets[target]?.aggregate?.[field], digits),
    );
  }
  return cells;
}

let md = `# Vitiate vs jazzer.js benchmark - ${report.date.slice(0, 10)} (${mode})

Generated by \`benchmarks/run-bench.mjs\`. Protocol: ${duration}s per fuzzer per
target, ${runs} run(s), sequential on the same host.

## Metadata

- vitiate: \`${setupMeta.vitiateSha}\`${setupMeta.vitiateDirty ? " (dirty working tree)" : ""}
- xword-parser harnesses: ${Object.entries(setupMeta.harnesses)
  .map(
    ([n, h]) =>
      `${n}=\`${h.sha.slice(0, 7)}\` (${h.branch}, ${Object.keys(h.overlayFiles).length} overlay files)`,
  )
  .join(", ")}
- node: ${setupMeta.nodeVersion}, platform: ${setupMeta.platform}
- engine binary sha256: \`${setupMeta.engineBinary.sha256.slice(0, 16)}...\`
- vitiate exec/s includes calibration executions (post-C6 honest stats)
`;

if (report.invalidRuns.length) {
  md += `\n## ⚠ INVALID RUNS - numbers below are not trustworthy\n\n`;
  for (const inv of report.invalidRuns) {
    md += `- **${inv.fuzzer}/${inv.target}** run ${inv.run ?? "-"}: ${inv.problems.join("; ")}\n`;
  }
}

if (a && b) {
  md += `\n## Throughput (median exec/s across status samples, mean over runs)\n\n`;
  md += `| Target | vitiate | jazzer | ratio (jazzer/vitiate) |\n|---|---|---|---|\n`;
  for (const t of targetNames) {
    const [v] = aggRow(t, "execsPerSecMedian");
    const bAgg = report.fuzzers[b]?.targets[t]?.aggregate?.execsPerSecMedian;
    const vAgg = report.fuzzers[a]?.targets[t]?.aggregate?.execsPerSecMedian;
    const ratio = vAgg && bAgg ? (bAgg / vAgg).toFixed(1) + "x" : "-";
    md += `| ${t} | ${v} | ${fmt(bAgg)} | ${ratio} |\n`;
  }
}

md += `\n## Coverage

> vitiate \`edges\` (instrumented source branch decision points) and jazzer
> \`cov\` (libFuzzer V8 basic-block coverage) have different granularities and
> are NOT directly comparable (design review C1/C3). Recorded raw.

| Target | ${[a, b]
  .filter(Boolean)
  .map((n) => `${n} ${n === "vitiate" ? "edges" : "cov"} | ${n} ft`)
  .join(" | ")} |
|---|${[a, b]
  .filter(Boolean)
  .map(() => "---|---")
  .join("|")}|
`;
for (const t of targetNames) {
  const cells = [a, b]
    .filter(Boolean)
    .map((n) => {
      const agg = report.fuzzers[n]?.targets[t]?.aggregate;
      return `${fmt(agg?.coverage)} | ${fmt(agg?.features)}`;
    })
    .join(" | ");
  md += `| ${t} | ${cells} |\n`;
}

md += `\n## Corpus size / startup latency / crashes\n\n`;
md += `| Target | ${[a, b]
  .filter(Boolean)
  .map((n) => `${n} corpus | ${n} startup (s) | ${n} crashes`)
  .join(" | ")} |\n`;
md += `|---|${[a, b]
  .filter(Boolean)
  .map(() => "---|---|---")
  .join("|")}|\n`;
for (const t of targetNames) {
  const cells = [a, b]
    .filter(Boolean)
    .map((n) => {
      const agg = report.fuzzers[n]?.targets[t]?.aggregate;
      return `${fmt(agg?.corpusSize)} | ${fmt(agg?.startupLatencySec, 1)} | ${fmt(agg?.crashes)}`;
    })
    .join(" | ");
  md += `| ${t} | ${cells} |\n`;
}

md += `\n## Regression suite timing\n\n`;
for (const name of [a, b].filter(Boolean)) {
  const f = report.fuzzers[name];
  md += `- ${name}: ${fmt(f.regressionMeanSec, 1)}s mean over ${f.regressionRuns} run(s)\n`;
}

md += `\n## Per-run detail\n\n| Fuzzer | Target | Run | exec/s (med) | wall (s) | exit | crashes | status |\n|---|---|---|---|---|---|---|---|\n`;
for (const name of [a, b].filter(Boolean)) {
  for (const [t, data] of Object.entries(report.fuzzers[name].targets)) {
    for (const r of data.runs) {
      const status = r.problems.length
        ? `INVALID: ${r.problems.join("; ")}`
        : "ok";
      md += `| ${name} | ${t} | ${r.run} | ${fmt(r.execsPerSec?.median)} | ${fmt(r.wallTimeSec, 1)} | ${r.exitCode} | ${r.crashes ?? 0} | ${status} |\n`;
    }
  }
}

const jsonPath = join(RESULTS, `${stamp}-${mode}.json`);
const mdPath = join(RESULTS, `${stamp}-${mode}.md`);
writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
writeFileSync(mdPath, md);

log(`report: ${mdPath}`);
log(`raw data: ${jsonPath}`);

if (report.invalidRuns.length) {
  console.error(
    `\n[bench] ⚠ ${report.invalidRuns.length} INVALID run(s) - see the report banner. Numbers are not trustworthy.`,
  );
  for (const inv of report.invalidRuns) {
    console.error(
      `[bench]   ${inv.fuzzer}/${inv.target} run ${inv.run ?? "-"}: ${inv.problems.join("; ")}`,
    );
  }
  process.exit(1);
}
log("all runs valid");
