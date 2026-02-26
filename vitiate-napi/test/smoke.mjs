import assert from "node:assert/strict";
import {
  createCoverageMap,
  Fuzzer,
  ExitKind,
  IterationResult,
} from "../index.js";

// Create coverage map.
const MAP_SIZE = 65536;
const covMap = createCoverageMap(MAP_SIZE);
assert.equal(covMap.length, MAP_SIZE);

// Verify all bytes are zero.
for (let i = 0; i < covMap.length; i++) {
  assert.equal(covMap[i], 0, `Expected zero at index ${i}`);
}

// Create fuzzer with coverage map.
const fuzzer = new Fuzzer(covMap, { maxInputLen: 1024 });

// Verify initial stats.
let stats = fuzzer.stats;
assert.equal(stats.totalExecs, 0);
assert.equal(stats.corpusSize, 0);
assert.equal(stats.solutionCount, 0);
assert.equal(stats.coverageEdges, 0);
assert.equal(stats.execsPerSec, 0);

// Add a seed.
fuzzer.addSeed(Buffer.from("hello"));
stats = fuzzer.stats;
assert.equal(stats.corpusSize, 1);

// Run 1000 iterations with a target that sets coverage map bytes based on input.
const ITERATIONS = 1000;
let interestingCount = 0;

for (let i = 0; i < ITERATIONS; i++) {
  const input = fuzzer.getNextInput();

  // Target function: set coverage map bytes based on input content.
  // Different input bytes trigger different "edges" in the coverage map.
  for (let j = 0; j < Math.min(input.length, 256); j++) {
    const edgeIndex = (input[j] * 251 + j * 7) % MAP_SIZE;
    covMap[edgeIndex] = Math.min(covMap[edgeIndex] + 1, 255);
  }

  // Special edge for inputs starting with certain bytes.
  if (input.length > 0) {
    covMap[input[0]] = 1;
  }
  if (input.length > 1) {
    covMap[256 + input[1]] = 1;
  }

  const result = fuzzer.reportResult(ExitKind.Ok);
  if (result === IterationResult.Interesting) {
    interestingCount++;
  }
}

// Verify final stats.
stats = fuzzer.stats;
assert.equal(stats.totalExecs, ITERATIONS);
assert.ok(
  stats.corpusSize > 1,
  `Corpus should have grown from 1, got ${stats.corpusSize}`,
);
assert.ok(
  stats.coverageEdges > 0,
  `Coverage edges should be > 0, got ${stats.coverageEdges}`,
);
assert.ok(
  stats.execsPerSec > 0,
  `Execs/sec should be > 0, got ${stats.execsPerSec}`,
);
assert.equal(stats.solutionCount, 0);
assert.ok(
  interestingCount > 0,
  `Should have found at least one interesting input, got ${interestingCount}`,
);

// Verify the coverage map was zeroed after the last reportResult.
let allZero = true;
for (let i = 0; i < covMap.length; i++) {
  if (covMap[i] !== 0) {
    allZero = false;
    break;
  }
}
assert.ok(allZero, "Coverage map should be zeroed after reportResult");

// Test crash path: report a crash and verify it becomes a solution.
{
  fuzzer.getNextInput(); // called for side effect (sets last_input)
  covMap[0] = 1; // non-zero coverage before report
  const result = fuzzer.reportResult(ExitKind.Crash);
  assert.equal(
    result,
    IterationResult.Solution,
    "Crash should be flagged as a solution",
  );
  stats = fuzzer.stats;
  assert.equal(
    stats.solutionCount,
    1,
    `Expected 1 solution after crash, got ${stats.solutionCount}`,
  );
}

// Verify coverage map is zeroed after crash report.
{
  let allZeroCrash = true;
  for (let i = 0; i < covMap.length; i++) {
    if (covMap[i] !== 0) {
      allZeroCrash = false;
      break;
    }
  }
  assert.ok(
    allZeroCrash,
    "Coverage map should be zeroed after crash reportResult",
  );
}

// Test timeout path: report a timeout and verify it becomes a solution.
{
  fuzzer.getNextInput(); // called for side effect (sets last_input)
  covMap[1] = 1; // non-zero coverage before report
  const result = fuzzer.reportResult(ExitKind.Timeout);
  assert.equal(
    result,
    IterationResult.Solution,
    "Timeout should be flagged as a solution",
  );
  stats = fuzzer.stats;
  assert.equal(
    stats.solutionCount,
    2,
    `Expected 2 solutions after timeout, got ${stats.solutionCount}`,
  );
}

// Verify coverage map is zeroed after timeout report.
{
  let allZeroTimeout = true;
  for (let i = 0; i < covMap.length; i++) {
    if (covMap[i] !== 0) {
      allZeroTimeout = false;
      break;
    }
  }
  assert.ok(
    allZeroTimeout,
    "Coverage map should be zeroed after timeout reportResult",
  );
}

// Verify totalExecs includes crash+timeout iterations.
assert.equal(
  stats.totalExecs,
  ITERATIONS + 2,
  `Expected ${ITERATIONS + 2} total execs after crash+timeout, got ${stats.totalExecs}`,
);

console.log("Smoke test passed!");
console.log(`  Total execs: ${stats.totalExecs}`);
console.log(`  Corpus size: ${stats.corpusSize}`);
console.log(`  Coverage edges: ${stats.coverageEdges}`);
console.log(`  Execs/sec: ${stats.execsPerSec.toFixed(0)}`);
console.log(`  Interesting inputs found: ${interestingCount}`);
console.log(`  Solutions: ${stats.solutionCount}`);
