#!/usr/bin/env node

/**
 * Benchmark setup: prepare the two xword-parser harness checkouts.
 *
 * 1. Packs the local vitiate workspace packages into tarballs (including the
 *    platform-specific engine package with the locally built native binary).
 * 2. Clones the xword-parser harness branches at pinned SHAs into vendor/.
 * 3. Overlays uncommitted fuzz-harness improvements from the sibling working
 *    trees (read-only copies; no git operations touch the source repos).
 * 4. Redirects the vitiate checkout's published @vitiate/* deps to the local
 *    tarballs via pnpm overrides, so runs measure the local build.
 * 5. Installs and builds both checkouts.
 *
 * Idempotent: clones are skipped when already at the pinned SHA; tarballs,
 * overlays, and installs are refreshed on every invocation (rerun after any
 * engine rebuild).
 *
 * Usage: node setup.mjs
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH_ROOT = dirname(fileURLToPath(import.meta.url));
const VITIATE_ROOT = resolve(BENCH_ROOT, "..");
const VENDOR = join(BENCH_ROOT, "vendor");
const TARBALL_DIR = join(VENDOR, "tarballs");

const config = JSON.parse(
  readFileSync(join(BENCH_ROOT, "bench.config.json"), "utf-8"),
);

function expandHome(p) {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function log(msg) {
  console.log(`[setup] ${msg}`);
}

function fail(msg) {
  console.error(`[setup] ERROR: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const pretty = `${cmd} ${args.join(" ")}${opts.cwd ? ` (in ${opts.cwd})` : ""}`;
  log(pretty);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    ...opts,
  });
  if (result.status !== 0) {
    fail(`command failed (exit ${result.status}): ${pretty}`);
  }
}

function capture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf-8",
    shell: false,
    ...opts,
  });
  if (result.status !== 0) {
    fail(`command failed (exit ${result.status}): ${cmd} ${args.join(" ")}`);
  }
  return result.stdout.trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ── 1. Platform detection & engine binary check ────────────────────────────

const PLATFORM_MAP = {
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "darwin-arm64": "darwin-arm64",
};
const platformKey = `${process.platform}-${process.arch}`;
const napiTriple = PLATFORM_MAP[platformKey];
if (!napiTriple) {
  fail(`unsupported platform ${platformKey}; extend PLATFORM_MAP in setup.mjs`);
}

const engineBinary = join(
  VITIATE_ROOT,
  "vitiate-engine",
  `vitiate-engine.${napiTriple}.node`,
);
if (!existsSync(engineBinary)) {
  fail(
    `engine binary not found: ${engineBinary} - run "pnpm build" in the vitiate repo first`,
  );
}
const coreDist = join(VITIATE_ROOT, "vitiate-core", "dist", "index.js");
if (!existsSync(coreDist)) {
  fail(
    `@vitiate/core dist not found - run "pnpm build" in the vitiate repo first`,
  );
}

// ── 2. Pack workspace tarballs ──────────────────────────────────────────────

rmSync(TARBALL_DIR, { recursive: true, force: true });
mkdirSync(TARBALL_DIR, { recursive: true });

const PACK_DIRS = [
  "vitiate-engine",
  "vitiate-swc-plugin",
  "vitiate-core",
  "vitiate",
  "vitiate-fuzzed-data-provider",
];
for (const dir of PACK_DIRS) {
  run("pnpm", ["pack", "--pack-destination", TARBALL_DIR], {
    cwd: join(VITIATE_ROOT, dir),
  });
}

// The platform package ships only from CI releases; its npm/ dir in the repo
// has no binary. Stage a copy with the locally built binary and pack that.
const platformPkgSrc = join(VITIATE_ROOT, "vitiate-engine", "npm", napiTriple);
const staging = join(VENDOR, "platform-pkg-staging");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
copyFileSync(
  join(platformPkgSrc, "package.json"),
  join(staging, "package.json"),
);
copyFileSync(engineBinary, join(staging, basename(engineBinary)));
run("pnpm", ["pack", "--pack-destination", TARBALL_DIR], { cwd: staging });
rmSync(staging, { recursive: true, force: true });

const tarballs = {};
for (const file of readdirSync(TARBALL_DIR)) {
  if (!file.endsWith(".tgz")) continue;
  // pnpm pack names tarballs <name>-<version>.tgz with @scope/ as scope-.
  const path = join(TARBALL_DIR, file);
  if (
    file.startsWith("vitiate-engine-linux") ||
    file.startsWith("vitiate-engine-darwin") ||
    file.startsWith("vitiate-engine-win32")
  ) {
    tarballs[`@vitiate/engine-${napiTriple}`] = path;
  } else if (file.startsWith("vitiate-engine-")) {
    tarballs["@vitiate/engine"] = path;
  } else if (file.startsWith("vitiate-swc-plugin-")) {
    tarballs["@vitiate/swc-plugin"] = path;
  } else if (file.startsWith("vitiate-core-")) {
    tarballs["@vitiate/core"] = path;
  } else if (file.startsWith("vitiate-fuzzed-data-provider-")) {
    tarballs["@vitiate/fuzzed-data-provider"] = path;
  } else if (file.startsWith("vitiate-")) {
    tarballs["vitiate"] = path;
  }
}
log(`packed ${Object.keys(tarballs).length} tarballs`);
const EXPECTED = [
  "@vitiate/engine",
  `@vitiate/engine-${napiTriple}`,
  "@vitiate/swc-plugin",
  "@vitiate/core",
  "@vitiate/fuzzed-data-provider",
  "vitiate",
];
for (const name of EXPECTED) {
  if (!tarballs[name]) fail(`missing tarball for ${name}`);
}

// ── 3. Clone harness checkouts at pinned SHAs ───────────────────────────────

const source = expandHome(config.source);
if (!existsSync(source)) {
  fail(`harness source repo not found: ${source}`);
}

const overlayHashes = {};

for (const [name, harness] of Object.entries(config.harnesses)) {
  const dest = join(VENDOR, `xword-${name}`);

  const atPin =
    existsSync(dest) &&
    spawnSync("git", ["-C", dest, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).stdout?.trim() === harness.sha;

  if (atPin) {
    log(`${name}: already at ${harness.sha.slice(0, 7)}, skipping clone`);
  } else {
    rmSync(dest, { recursive: true, force: true });
    run("git", ["clone", "--branch", harness.branch, source, dest]);
    run("git", ["-C", dest, "checkout", "--detach", harness.sha]);
  }

  // Overlay uncommitted fuzz-harness files from the sibling working tree
  // (improvements that exist there but were never committed to the branch).
  overlayHashes[name] = {};
  if (harness.overlay) {
    const overlayDir = expandHome(harness.overlay.dir);
    if (!existsSync(overlayDir)) {
      fail(`${name}: overlay dir not found: ${overlayDir}`);
    }
    for (const rel of harness.overlay.files) {
      const src = join(overlayDir, rel);
      if (!existsSync(src)) {
        fail(`${name}: overlay file not found: ${src}`);
      }
      cpSync(src, join(dest, rel));
      overlayHashes[name][rel] = sha256(src);
    }
    log(
      `${name}: overlaid ${harness.overlay.files.length} files from ${overlayDir}`,
    );
  } else {
    log(`${name}: no overlay configured`);
  }

  // testdata/ (seed corpus) is gitignored in the harness repos; both
  // harnesses seed their corpus from <checkout>/testdata at run time.
  const testdataSrc = expandHome(config.testdata);
  if (!existsSync(testdataSrc)) {
    fail(`testdata repo not found: ${testdataSrc}`);
  }
  cpSync(testdataSrc, join(dest, "testdata"), {
    recursive: true,
    filter: (src) => !src.includes("/.git"),
  });
  log(`${name}: copied testdata from ${testdataSrc}`);
}

// ── 4. Make each checkout its own pnpm workspace root ───────────────────────
// The checkouts live under the vitiate repo, so without their own
// pnpm-workspace.yaml every pnpm invocation (setup installs AND the vendored
// scripts' `pnpm exec` calls) would walk up and resolve the vitiate
// workspace instead. The vitiate checkout's workspace file also carries the
// overrides that redirect its published @vitiate/* deps to the local
// tarballs.

const vitiateCheckout = join(VENDOR, "xword-vitiate");

for (const [name, harness] of Object.entries(config.harnesses)) {
  // Version pins from bench.config.json (fairness: e.g. both harnesses must
  // fuzz the same fast-xml-parser), plus - for the vitiate checkout - the
  // redirects to tarballs packed from the local vitiate build.
  const overrides = {
    ...harness.overrides,
    ...(name === "vitiate"
      ? Object.fromEntries(
          Object.entries(tarballs).map(([n, p]) => [n, `file:${p}`]),
        )
      : {}),
  };
  let yaml =
    "# generated by benchmarks/setup.mjs - marks this checkout as its own workspace root\n" +
    "packages: []\n" +
    // pnpm 10 skips dependency build scripts unless allowlisted; jazzer's
    // native fuzzer addon and the toolchain binaries need theirs to run.
    "onlyBuiltDependencies:\n" +
    ["@jazzer.js/fuzzer", "@swc/core", "esbuild", "lefthook"]
      .map((n) => `  - "${n}"\n`)
      .join("");
  if (Object.keys(overrides).length) {
    yaml +=
      "overrides:\n" +
      Object.entries(overrides)
        .map(([n, v]) => `  "${n}": "${v}"\n`)
        .join("");
  }
  writeFileSync(join(VENDOR, `xword-${name}`, "pnpm-workspace.yaml"), yaml);
  log(`${name}: wrote ${Object.keys(overrides).length} pnpm overrides`);
}

// ── 5. Install & build both checkouts ───────────────────────────────────────

for (const name of Object.keys(config.harnesses)) {
  const dest = join(VENDOR, `xword-${name}`);
  run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: dest });
  // The harness build's browser-bundle step fails under current esbuild
  // (destructuring vs the project's old browser targets). Only the CJS
  // dist/index.js matters here - the jazzer fuzz targets require() it - so
  // tolerate a partial build as long as that artifact was produced.
  const build = spawnSync("pnpm", ["run", "build"], {
    cwd: dest,
    stdio: "inherit",
    shell: false,
  });
  const distIndex = join(dest, "dist", "index.js");
  if (!existsSync(distIndex)) {
    fail(`${name}: build did not produce ${distIndex}`);
  }
  if (build.status !== 0) {
    log(
      `${name}: build exited ${build.status} (browser bundle step); dist/index.js present, continuing`,
    );
  }
}

// Sanity check: the installed @vitiate/core must come from the local tarball,
// not the npm registry. The packed version string matches the registry's, so
// compare file content instead.
const installedCore = join(
  vitiateCheckout,
  "node_modules",
  "@vitiate",
  "core",
  "dist",
  "index.js",
);
if (!existsSync(installedCore)) {
  fail("@vitiate/core not installed in the vitiate checkout");
}
if (sha256(installedCore) !== sha256(coreDist)) {
  fail(
    "@vitiate/core in the vitiate checkout does not match the local build - pnpm overrides did not take effect",
  );
}
log("verified: vitiate checkout uses the local @vitiate/core build");

// ── 6. Record setup metadata for the report ─────────────────────────────────

const meta = {
  setupDate: new Date().toISOString(),
  vitiateSha: capture("git", ["rev-parse", "HEAD"], { cwd: VITIATE_ROOT }),
  vitiateDirty:
    capture("git", ["status", "--porcelain"], { cwd: VITIATE_ROOT }).length > 0,
  harnesses: Object.fromEntries(
    Object.entries(config.harnesses).map(([name, h]) => [
      name,
      { branch: h.branch, sha: h.sha, overlayFiles: overlayHashes[name] },
    ]),
  ),
  engineBinary: { path: engineBinary, sha256: sha256(engineBinary) },
  nodeVersion: process.version,
  platform: platformKey,
};
writeFileSync(
  join(VENDOR, "setup-meta.json"),
  JSON.stringify(meta, null, 2) + "\n",
);
log("setup complete - metadata written to vendor/setup-meta.json");
