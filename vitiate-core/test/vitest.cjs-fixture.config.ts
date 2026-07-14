import { defineConfig } from "vitest/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vitiatePlugin } from "../src/plugin.js";

// A purpose-built multi-file CommonJS fixture the CJS-instrumentation e2e drives
// for scenarios the real npm targets (node-forge/jpeg-js) do not exercise: a
// submodule that calls a hooked builtin (child_process.execSync) for the
// detector test, and a submodule that throws through several frames for the
// source-map test. It is written into vitiate-core/node_modules so it resolves
// under a real `/node_modules/<pkg>/` path (matched by isListedPackage) and is
// compiled by the resolveId/load hooks. node_modules is gitignored, so nothing
// is committed. Written at config-load time (before the plugin's buildStart
// eagerly resolves it).
const FIXTURE_NAME = "vitiate-cjs-fixture";
const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  FIXTURE_NAME,
);

mkdirSync(fixtureDir, { recursive: true });
writeFileSync(
  path.join(fixtureDir, "package.json"),
  JSON.stringify({ name: FIXTURE_NAME, version: "1.0.0", main: "index.js" }),
);
// Calls a hooked builtin from inside the package, through the bundle's require
// bridge.
writeFileSync(
  path.join(fixtureDir, "exec.js"),
  "const cp = require('child_process');\n" +
    "exports.runCommand = (s) => cp.execSync(s);\n",
);
// Throws through several frames so the source map has real frames to remap.
writeFileSync(
  path.join(fixtureDir, "crash.js"),
  "function explode(s) {\n" +
    "  throw new Error('cjs fixture crash: ' + s);\n" +
    "}\n" +
    "function deeper(s) {\n" +
    "  return explode(s);\n" +
    "}\n" +
    "exports.crash = (s) => {\n" +
    "  if (String(s).includes('BOOM')) return deeper(s);\n" +
    "  return null;\n" +
    "};\n",
);
writeFileSync(
  path.join(fixtureDir, "index.js"),
  "module.exports = Object.assign(\n" +
    "  {},\n" +
    "  require('./exec'),\n" +
    "  require('./crash'),\n" +
    "  { named: 123 },\n" +
    ");\n",
);

export default defineConfig({
  plugins: [
    vitiatePlugin({
      instrument: {
        packages: [FIXTURE_NAME],
      },
      coverageMapSize: 131072,
    }),
  ],
  test: {
    include: ["test/e2e-cjs-fixture.test.ts"],
    pool: "forks",
  },
});
