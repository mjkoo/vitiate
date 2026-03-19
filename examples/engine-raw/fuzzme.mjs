#!/usr/bin/env node
/**
 * Documentation example: instrument a target with the SWC WASM plugin,
 * then fuzz it with the @vitiate/engine LibAFL engine until a crash is found.
 * For the recommended workflow, use the Vitest plugin (see examples/url-parser/).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Resolve dependencies from the vitiate package (which declares them)
const require = createRequire(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../vitiate-core/package.json",
  ),
);
const { transformSync } = require("@swc/core");
const {
  createCoverageMap,
  Fuzzer,
  ExitKind,
  IterationResult,
  traceCmpRecord,
} = require("@vitiate/engine");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. The target: a simple "fuzzme" function
// ---------------------------------------------------------------------------
const TARGET_SOURCE = `
function fuzzme(data) {
  if (data.length > 0 && data[0] === 0x46) {       // 'F'
    if (data.length > 1 && data[1] === 0x55) {     // 'U'
      if (data.length > 2 && data[2] === 0x5a) {   // 'Z'
        if (data.length > 3 && data[3] === 0x5a) { // 'Z'
          throw new Error("CRASH: found the magic input 'FUZZ'!");
        }
      }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// 2. Instrument the target using the SWC WASM plugin
// ---------------------------------------------------------------------------
const wasmPluginPath = path.resolve(
  __dirname,
  "../../vitiate-swc-plugin/vitiate_swc_plugin.wasm",
);

console.log("Instrumenting target with SWC WASM plugin...");

const result = transformSync(TARGET_SOURCE, {
  filename: "fuzzme.js",
  jsc: {
    parser: { syntax: "ecmascript" },
    target: "es2022",
    experimental: {
      plugins: [
        [
          wasmPluginPath,
          {
            coverageMapSize: 65536,
            traceCmp: true,
            coverageGlobalName: "__vitiate_cov",
            traceCmpGlobalName: "__vitiate_trace_cmp_record",
          },
        ],
      ],
    },
  },
  isModule: false,
});

const instrumentedCode = result.code;

console.log("\n--- Instrumented code ---");
console.log(instrumentedCode);
console.log("--- End instrumented code ---\n");

// ---------------------------------------------------------------------------
// 3. Set up the runtime: coverage map + globals
// ---------------------------------------------------------------------------
const MAP_SIZE = 65536;
const covMap = createCoverageMap(MAP_SIZE);

// Expose the coverage map and traceCmpRecord to the instrumented code via globals
globalThis.__vitiate_cov = covMap;
globalThis.__vitiate_trace_cmp_record = traceCmpRecord;

// Compile the instrumented code in the current global context so it can
// access __vitiate_cov and __vitiate_trace_cmp_record
vm.runInThisContext(instrumentedCode, { filename: "fuzzme.js" });

// `fuzzme` is now defined in the global scope by the vm.runInThisContext call
const target = globalThis.fuzzme;

// ---------------------------------------------------------------------------
// 4. Fuzz loop
// ---------------------------------------------------------------------------
const fuzzer = new Fuzzer(covMap, { maxInputLen: 256 });
fuzzer.addSeed(Buffer.from(""));
fuzzer.addSeed(Buffer.from("F"));
fuzzer.addSeed(Buffer.from("FU"));

const MAX_ITERATIONS = 1_000_000;
let crashInput = null;

console.log("Fuzzing started...\n");
const startTime = Date.now();

for (let i = 0; i < MAX_ITERATIONS; i++) {
  const input = fuzzer.getNextInput();

  let exitKind = ExitKind.Ok;
  const execStart = process.hrtime.bigint();
  try {
    target(input);
  } catch (e) {
    exitKind = ExitKind.Crash;
    crashInput = { input: Buffer.from(input), error: e, iteration: i + 1 };
  }
  const execTimeNs = Number(process.hrtime.bigint() - execStart);

  const iterResult = fuzzer.reportResult(exitKind, execTimeNs);

  // Print progress every 10k iterations
  if ((i + 1) % 10_000 === 0) {
    const stats = fuzzer.stats;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[${elapsed}s] execs: ${stats.totalExecs} | corpus: ${stats.corpusSize} | ` +
        `edges: ${stats.coverageEdges} | execs/s: ${stats.execsPerSec.toFixed(0)} | ` +
        `solutions: ${stats.solutionCount}`,
    );
  }

  if (iterResult === IterationResult.Solution) {
    break;
  }
}

// ---------------------------------------------------------------------------
// 5. Report results
// ---------------------------------------------------------------------------
const stats = fuzzer.stats;
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

console.log("\n========================================");
if (crashInput) {
  console.log("CRASH FOUND!");
  console.log(`  Iteration:  ${crashInput.iteration}`);
  console.log(`  Input hex:  ${crashInput.input.toString("hex")}`);
  console.log(`  Input str:  ${JSON.stringify(crashInput.input.toString())}`);
  console.log(`  Error:      ${crashInput.error.message}`);
} else {
  console.log("No crash found within iteration limit.");
}
console.log("----------------------------------------");
console.log(`  Total execs:    ${stats.totalExecs}`);
console.log(`  Corpus size:    ${stats.corpusSize}`);
console.log(`  Coverage edges: ${stats.coverageEdges}`);
console.log(`  Execs/sec:      ${stats.execsPerSec.toFixed(0)}`);
console.log(`  Solutions:      ${stats.solutionCount}`);
console.log(`  Time:           ${elapsed}s`);
console.log("========================================");

process.exit(crashInput ? 0 : 1);
