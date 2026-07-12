/**
 * paths subcommand: read-only inspector mapping each fuzz test to its
 * testdata/corpus directory with per-bucket counts, orphan detection, and
 * (opt-in) pruning.
 */
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import type { InferValue } from "@optique/core/parser";
import { getProjectRoot, getDataDir } from "../config.js";
import { listOnDiskHashDirs, countOrphanEntries } from "../corpus.js";
import { pathsParser } from "./parsers.js";
import {
  discoverFuzzTests,
  buildTestManifest,
  type TestManifestRow,
} from "./discover.js";

/** An on-disk hash dir with no matching discovered test. */
export interface OrphanDir {
  kind: "testdata" | "corpus";
  hashDir: string;
  /** Absolute path to the orphaned directory. */
  path: string;
  /** Entry count, for reporting (see {@link countOrphanEntries}). */
  entries: number;
}

/**
 * Find on-disk `testdata/`+`corpus/` hash dirs that match no discovered test.
 * These are leftovers from renamed or deleted tests.
 */
export function findOrphans(manifest: TestManifestRow[]): OrphanDir[] {
  const known = new Set(manifest.map((r) => r.hashDir));
  const orphans: OrphanDir[] = [];
  for (const kind of ["testdata", "corpus"] as const) {
    for (const hashDir of listOnDiskHashDirs(kind)) {
      if (known.has(hashDir)) continue;
      orphans.push({
        kind,
        hashDir,
        path: path.join(getDataDir(), kind, hashDir),
        entries: countOrphanEntries(kind, hashDir),
      });
    }
  }
  return orphans;
}

/**
 * Select which orphans a prune should delete: corpus orphans always, testdata
 * orphans only when `all` is set (they may hold committed crashes/seeds).
 */
export function selectPruneTargets(
  orphans: OrphanDir[],
  all: boolean,
): OrphanDir[] {
  return orphans.filter((o) => o.kind === "corpus" || all);
}

/** Delete the given orphan directories. Pure side effect (no prompting). */
export function deleteOrphans(targets: OrphanDir[]): void {
  for (const t of targets) {
    rmSync(t.path, { recursive: true, force: true });
  }
}

/**
 * Prompt for a yes/no answer; resolves true only on y/yes. Streams are
 * injectable for testing and default to the process stdio.
 */
export function promptYesNo(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    rl.question(question, (answer) => {
      // Resolve before close(): rl.close() emits "close", and resolving first
      // makes the close-handler's resolve(false) a no-op for an answered prompt.
      resolve(/^y(es)?$/i.test(answer.trim()));
      rl.close();
    });
    // EOF (Ctrl-D) or a closed stdin fires "close" without an answer: treat as
    // a declined prompt rather than leaving the promise pending forever.
    rl.on("close", () => resolve(false));
  });
}

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

/**
 * Validate the paths flag combination. Returns an error message (without the
 * `vitiate: error:` prefix) or `null` if the flags are consistent.
 *
 * `--all`/`--force` are only meaningful with `--prune`, and `--dir`/`--json`/
 * `--prune` are mutually-exclusive output/action modes.
 */
export function validatePathsFlags(
  parsed: InferValue<typeof pathsParser>,
): string | null {
  if (parsed.all && !parsed.prune) {
    return "--all is only valid with --prune.";
  }
  if (parsed.force && !parsed.prune) {
    return "--force is only valid with --prune.";
  }
  const modes = [parsed.dir, parsed.json, parsed.prune].filter(Boolean).length;
  if (modes > 1) {
    return "--dir, --json, and --prune are mutually exclusive.";
  }
  return null;
}

/**
 * Decide orphan handling for a paths invocation. An empty manifest means the
 * test set is unknown (no fuzz tests discovered), so every on-disk directory
 * would look orphaned; orphan scanning and pruning are refused in that case to
 * avoid deleting live data. Orphans are only scanned when an orphan-consuming
 * flag (`--orphans`/`--prune`/`--json`) is set and the manifest is non-empty.
 */
export function resolveOrphans(
  manifest: TestManifestRow[],
  parsed: InferValue<typeof pathsParser>,
): { refuse: boolean; orphans: OrphanDir[] } {
  if (manifest.length === 0) {
    if (parsed.orphans || parsed.prune) {
      return { refuse: true, orphans: [] };
    }
    return { refuse: false, orphans: [] };
  }
  const wantOrphans = parsed.orphans || parsed.prune || parsed.json;
  return { refuse: false, orphans: wantOrphans ? findOrphans(manifest) : [] };
}

/** Message for an empty paths table: distinguishes no-tests from no-match. */
export function pathsEmptyMessage(pattern?: string): string {
  return pattern === undefined
    ? "No fuzz tests (*.fuzz.*) found."
    : `No fuzz tests match ${JSON.stringify(pattern)}.`;
}

/**
 * paths subcommand: read-only inspector mapping each fuzz test to its
 * testdata/corpus directory with per-bucket counts, with pattern filtering,
 * orphan detection, and (opt-in) pruning.
 */
export async function runPathsSubcommand(
  parsed: InferValue<typeof pathsParser>,
): Promise<void> {
  const flagError = validatePathsFlags(parsed);
  if (flagError !== null) {
    process.stderr.write(`vitiate: error: ${flagError}\n`);
    process.exitCode = 1;
    return;
  }

  // Safety gate: without a known test set, every dir looks orphaned. Never
  // scan/prune on an unknown set. discoverFuzzTests prints its own error.
  const discovered = await discoverFuzzTests();
  if (discovered === null) {
    process.exitCode = 1;
    return;
  }

  const manifest = buildTestManifest(discovered);

  // Filter by pattern: case-insensitive substring over file, name, or hashDir.
  const pattern = parsed.pattern?.toLowerCase();
  const filtered =
    pattern === undefined
      ? manifest
      : manifest.filter(
          (r) =>
            r.file.toLowerCase().includes(pattern) ||
            r.name.toLowerCase().includes(pattern) ||
            r.hashDir.toLowerCase().includes(pattern),
        );

  // --dir: print only the unique match's testdata dir (for scripting/seeding).
  if (parsed.dir) {
    if (filtered.length !== 1) {
      const which =
        manifest.length === 0
          ? "no fuzz tests were discovered"
          : parsed.pattern === undefined
            ? "a PATTERN matching exactly one test"
            : `${filtered.length} tests match ${JSON.stringify(parsed.pattern)}`;
      process.stderr.write(
        `vitiate: error: --dir requires exactly one match (${which}).\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${filtered[0]!.testDataDir}\n`);
    return;
  }

  const { refuse, orphans } = resolveOrphans(manifest, parsed);
  if (refuse) {
    process.stderr.write(
      "vitiate: error: no fuzz tests discovered; refusing --orphans/--prune " +
        "(every directory would appear orphaned). Check you are in the right " +
        "project directory.\n",
    );
    process.exitCode = 1;
    return;
  }

  if (parsed.prune) {
    await prunePaths(orphans, parsed.all, parsed.force);
    return;
  }

  if (parsed.json) {
    renderPathsJson(filtered, orphans);
    return;
  }

  renderPathsTable(filtered, parsed.absolute, parsed.pattern);
  if (parsed.orphans) {
    renderOrphansSection(orphans, parsed.absolute);
  }
}

/**
 * Delete orphaned dirs, confirming first unless `force`. The `confirm` seam
 * defaults to an interactive stdin prompt but is injectable for tests.
 */
export async function prunePaths(
  orphans: OrphanDir[],
  all: boolean,
  force: boolean,
  confirm: (question: string) => Promise<boolean> = promptYesNo,
): Promise<void> {
  const targets = selectPruneTargets(orphans, all);
  if (targets.length === 0) {
    process.stdout.write("No orphaned directories to prune.\n");
    return;
  }

  process.stdout.write(
    `The following ${targets.length} orphaned ${plural(
      targets.length,
      "directory",
      "directories",
    )} will be deleted:\n`,
  );
  for (const t of targets) {
    process.stdout.write(
      `  ${t.kind}/${t.hashDir}  (${t.entries} ${plural(
        t.entries,
        "entry",
        "entries",
      )})\n`,
    );
  }
  const skipped = orphans.length - targets.length;
  if (skipped > 0) {
    process.stdout.write(
      `(${skipped} orphaned testdata ${plural(
        skipped,
        "dir",
        "dirs",
      )} left intact; pass --all to prune those too.)\n`,
    );
  }

  if (!force) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "vitiate: error: refusing to delete without confirmation; re-run with --force to prune non-interactively.\n",
      );
      process.exitCode = 1;
      return;
    }
    const confirmed = await confirm(
      `Delete ${targets.length} ${plural(
        targets.length,
        "directory",
        "directories",
      )}? [y/N] `,
    );
    if (!confirmed) {
      process.stdout.write("Aborted.\n");
      return;
    }
  }

  // Delete and report per target, so a mid-loop failure still shows exactly
  // what was removed instead of a bare Fatal with no audit trail.
  for (const t of targets) {
    deleteOrphans([t]);
    process.stdout.write(`Removed ${t.path}\n`);
  }
  process.stdout.write(
    `Pruned ${targets.length} ${plural(
      targets.length,
      "directory",
      "directories",
    )}.\n`,
  );
}

/** Render the test -> directory table with per-bucket counts. */
function renderPathsTable(
  rows: TestManifestRow[],
  absolute: boolean,
  pattern?: string,
): void {
  if (rows.length === 0) {
    process.stdout.write(`${pathsEmptyMessage(pattern)}\n`);
    return;
  }
  const projectRoot = getProjectRoot();
  const display = rows.map((r) => ({
    file: r.file,
    name: r.name,
    seeds: String(r.stats.seeds),
    crashes: String(r.stats.crashes),
    timeouts: String(r.stats.timeouts),
    dir: absolute ? r.testDataDir : path.relative(projectRoot, r.testDataDir),
  }));
  const fileW = Math.max(4, ...display.map((r) => r.file.length));
  const nameW = Math.max(4, ...display.map((r) => r.name.length));
  const seedsW = Math.max(5, ...display.map((r) => r.seeds.length));
  const crashW = Math.max(7, ...display.map((r) => r.crashes.length));
  const toW = Math.max(8, ...display.map((r) => r.timeouts.length));
  process.stdout.write(
    `${"File".padEnd(fileW)}  ${"Test".padEnd(nameW)}  ${"seeds".padStart(
      seedsW,
    )}  ${"crashes".padStart(crashW)}  ${"timeouts".padStart(
      toW,
    )}  Directory\n`,
  );
  process.stdout.write(
    `${"-".repeat(fileW)}  ${"-".repeat(nameW)}  ${"-".repeat(
      seedsW,
    )}  ${"-".repeat(crashW)}  ${"-".repeat(toW)}  ${"-".repeat(9)}\n`,
  );
  for (const r of display) {
    process.stdout.write(
      `${r.file.padEnd(fileW)}  ${r.name.padEnd(nameW)}  ${r.seeds.padStart(
        seedsW,
      )}  ${r.crashes.padStart(crashW)}  ${r.timeouts.padStart(toW)}  ${
        r.dir
      }\n`,
    );
  }
  process.stdout.write(
    `\n${rows.length} ${plural(rows.length, "test", "tests")}.\n`,
  );
}

/** Print the orphaned-directory section beneath the table. */
function renderOrphansSection(orphans: OrphanDir[], absolute: boolean): void {
  process.stdout.write("\n");
  if (orphans.length === 0) {
    process.stdout.write("No orphaned directories.\n");
    return;
  }
  const projectRoot = getProjectRoot();
  process.stdout.write(
    `Orphaned ${plural(
      orphans.length,
      "directory",
      "directories",
    )} (no matching test):\n`,
  );
  for (const o of orphans) {
    const dir = absolute ? o.path : path.relative(projectRoot, o.path);
    process.stdout.write(
      `  ${dir}  (${o.entries} ${plural(o.entries, "entry", "entries")})\n`,
    );
  }
  process.stdout.write(
    "\nRun `vitiate paths --prune` to delete orphaned corpus dirs (add --all for testdata).\n",
  );
}

/** Emit the manifest and orphans as JSON. */
function renderPathsJson(rows: TestManifestRow[], orphans: OrphanDir[]): void {
  const tests = rows.map((r) => ({
    file: r.file,
    name: r.name,
    hashDir: r.hashDir,
    testDataDir: r.testDataDir,
    corpusDir: r.corpusDir,
    seeds: r.stats.seeds,
    crashes: r.stats.crashes,
    timeouts: r.stats.timeouts,
    ooms: r.stats.ooms,
    corpus: r.stats.corpus,
  }));
  const out = {
    tests,
    orphans: orphans.map((o) => ({
      kind: o.kind,
      hashDir: o.hashDir,
      path: o.path,
      entries: o.entries,
    })),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
