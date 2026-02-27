import assert from "node:assert/strict";
import {
  createCoverageMap,
  Fuzzer,
  ExitKind,
  IterationResult,
  traceCmp,
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

// ===== traceCmp tests (Task 8.4) =====

// Strict equality
assert.equal(traceCmp(42, 42, 0, "==="), true, "42 === 42");
assert.equal(traceCmp(42, "42", 0, "==="), false, '42 === "42"');
assert.equal(traceCmp("hello", "hello", 0, "==="), true, '"hello" === "hello"');
assert.equal(traceCmp(null, undefined, 0, "==="), false, "null === undefined");
assert.equal(traceCmp(0, false, 0, "==="), false, "0 === false");

// Strict inequality
assert.equal(traceCmp(1, 2, 0, "!=="), true, "1 !== 2");
assert.equal(traceCmp(1, 1, 0, "!=="), false, "1 !== 1");
assert.equal(traceCmp("a", "b", 0, "!=="), true, '"a" !== "b"');

// Abstract equality (type coercion)
assert.equal(traceCmp(42, "42", 0, "=="), true, '42 == "42"');
assert.equal(traceCmp(null, undefined, 0, "=="), true, "null == undefined");
assert.equal(traceCmp(0, false, 0, "=="), true, "0 == false");
assert.equal(traceCmp(1, "2", 0, "=="), false, '1 == "2"');

// Abstract inequality
assert.equal(traceCmp(42, "42", 0, "!="), false, '42 != "42"');
assert.equal(traceCmp(1, 2, 0, "!="), true, "1 != 2");

// Less than
assert.equal(traceCmp(3, 5, 0, "<"), true, "3 < 5");
assert.equal(traceCmp(5, 3, 0, "<"), false, "5 < 3");
assert.equal(traceCmp(3, 3, 0, "<"), false, "3 < 3");
assert.equal(traceCmp("a", "b", 0, "<"), true, '"a" < "b"');

// Greater than
assert.equal(traceCmp(5, 3, 0, ">"), true, "5 > 3");
assert.equal(traceCmp(3, 5, 0, ">"), false, "3 > 5");

// Less than or equal
assert.equal(traceCmp(3, 5, 0, "<="), true, "3 <= 5");
assert.equal(traceCmp(3, 3, 0, "<="), true, "3 <= 3");
assert.equal(traceCmp(5, 3, 0, "<="), false, "5 <= 3");

// Greater than or equal
assert.equal(traceCmp("b", "a", 0, ">="), true, '"b" >= "a"');
assert.equal(traceCmp(3, 3, 0, ">="), true, "3 >= 3");
assert.equal(traceCmp(3, 5, 0, ">="), false, "3 >= 5");

// Unknown operator should throw
assert.throws(
  () => traceCmp(1, 2, 0, "???"),
  { message: /unknown operator/ },
  "unknown operator should throw",
);

console.log("traceCmp tests passed!");

// ===== CmpLog end-to-end tests (Task 5.4) =====

// Test that traceCmp records comparison operands and I2S mutations use them.
// Strategy: seed with "foo", emit constant comparison traceCmp("foo", "bar"),
// and verify I2S replaces "foo" with "bar" in generated inputs.
{
  const cmpMap = createCoverageMap(MAP_SIZE);
  const cmpFuzzer = new Fuzzer(cmpMap, { maxInputLen: 256, seed: 12345 });

  // Seed with a string containing one side of the comparison.
  cmpFuzzer.addSeed(Buffer.from("foo"));

  const CMP_ITERATIONS = 5000;
  let foundBar = false;
  let cmpCorpusGrew = false;

  for (let i = 0; i < CMP_ITERATIONS; i++) {
    const input = cmpFuzzer.getNextInput();

    // Emit a constant comparison: I2S will learn that "foo" <-> "bar".
    traceCmp("foo", "bar", 1, "===");

    // Set some coverage based on input content.
    if (input.length > 0) {
      cmpMap[input[0] % MAP_SIZE] = 1;
    }

    const result = cmpFuzzer.reportResult(ExitKind.Ok);
    if (result === IterationResult.Interesting) {
      cmpCorpusGrew = true;
    }

    // Check if I2S produced "bar" in the input.
    if (input.includes("bar")) {
      foundBar = true;
    }
  }

  assert.ok(
    cmpCorpusGrew,
    "CmpLog fuzzer corpus should grow with coverage feedback",
  );

  // I2S replacement should produce "bar" by replacing "foo" bytes in the input.
  assert.ok(
    foundBar,
    "I2S replacement should produce 'bar' from 'foo' comparison",
  );

  const cmpStats = cmpFuzzer.stats;
  assert.equal(cmpStats.totalExecs, CMP_ITERATIONS);
  console.log("CmpLog tests passed!");
  console.log(`  CmpLog corpus size: ${cmpStats.corpusSize}`);
  console.log(`  Found I2S replacement: ${foundBar}`);
}

// ===== Fuzzer smoke test summary =====
console.log("Smoke test passed!");
console.log(`  Total execs: ${stats.totalExecs}`);
console.log(`  Corpus size: ${stats.corpusSize}`);
console.log(`  Coverage edges: ${stats.coverageEdges}`);
console.log(`  Execs/sec: ${stats.execsPerSec.toFixed(0)}`);
console.log(`  Interesting inputs found: ${interestingCount}`);
console.log(`  Solutions: ${stats.solutionCount}`);
