import assert from "node:assert/strict";
import os from "node:os";
import {
  createCoverageMap,
  Fuzzer,
  Watchdog,
  ExitKind,
  IterationResult,
  traceCmpRecord,
  v8ShimAvailable,
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

// Add a seed (queued for evaluation, not yet in corpus).
fuzzer.addSeed(Buffer.from("hello"));
stats = fuzzer.stats;
assert.equal(stats.corpusSize, 0);

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

  const result = fuzzer.reportResult(ExitKind.Ok, 1000);
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
  const result = fuzzer.reportResult(ExitKind.Crash, 1000);
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
  const result = fuzzer.reportResult(ExitKind.Timeout, 1000);
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

// ===== traceCmpRecord tests =====

// traceCmpRecord returns void (no comparison evaluation)
assert.equal(
  traceCmpRecord(42, 42, 0, 0),
  undefined,
  "traceCmpRecord returns void",
);
assert.equal(
  traceCmpRecord("hello", "world", 0, 0),
  undefined,
  "traceCmpRecord returns void for strings",
);
assert.equal(
  traceCmpRecord(3, 5, 0, 4),
  undefined,
  "traceCmpRecord returns void for numbers",
);

// Invalid operator ID should not throw
assert.equal(
  traceCmpRecord(1, 2, 0, 99),
  undefined,
  "invalid operator ID does not throw",
);
assert.equal(
  traceCmpRecord(null, undefined, 0, 0),
  undefined,
  "null/undefined operands do not throw",
);

console.log("traceCmpRecord tests passed!");

// ===== CmpLog pipeline tests =====
{
  const cmpMap = createCoverageMap(MAP_SIZE);
  const cmpFuzzer = new Fuzzer(cmpMap, { maxInputLen: 256 });

  cmpFuzzer.addSeed(Buffer.from("test"));

  // Verify no CmpLog entries initially.
  assert.equal(cmpFuzzer.cmpLogEntryCount, 0);

  // Drain stale entries left by the traceCmpRecord tests above.
  // The global CmpLog accumulator still holds entries from those calls.
  cmpFuzzer.getNextInput();
  cmpMap[0] = 1;
  cmpFuzzer.reportResult(ExitKind.Ok, 1000);

  // Run one iteration with traceCmpRecord calls.
  cmpFuzzer.getNextInput();

  // String comparison → 1 Bytes entry (operator ID 0 = ===)
  traceCmpRecord("foo", "bar", 1, 0);

  // Integer comparison → 1 U8 + 1 Bytes entry = 2 entries
  traceCmpRecord(42, 100, 2, 0);

  cmpMap[0] = 1;
  cmpFuzzer.reportResult(ExitKind.Ok, 1000);

  // After reportResult, metadata should contain entries from traceCmpRecord calls.
  // String pair: 1 entry (Bytes). Number pair: 2 entries (U8 + Bytes).
  assert.equal(
    cmpFuzzer.cmpLogEntryCount,
    3,
    `Expected 3 CmpLog entries (1 string + 2 number), got ${cmpFuzzer.cmpLogEntryCount}`,
  );

  // Verify entries are replaced on next iteration.
  cmpFuzzer.getNextInput();
  traceCmpRecord("only", "one", 3, 0);
  cmpMap[1] = 1;
  cmpFuzzer.reportResult(ExitKind.Ok, 1000);
  assert.equal(
    cmpFuzzer.cmpLogEntryCount,
    1,
    `Expected 1 CmpLog entry after second iteration, got ${cmpFuzzer.cmpLogEntryCount}`,
  );

  // Verify skip types produce no entries.
  cmpFuzzer.getNextInput();
  traceCmpRecord(null, undefined, 4, 0); // both skip → no entry
  traceCmpRecord(true, false, 5, 0); // both skip → no entry
  cmpMap[2] = 1;
  cmpFuzzer.reportResult(ExitKind.Ok, 1000);
  assert.equal(
    cmpFuzzer.cmpLogEntryCount,
    0,
    `Expected 0 CmpLog entries for skip types, got ${cmpFuzzer.cmpLogEntryCount}`,
  );

  console.log("CmpLog pipeline tests passed!");
}

// ===== Watchdog smoke test =====
{
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vitiate-watchdog-"));

  // Test construction: Watchdog class should be available and constructible
  const wd = new Watchdog(tmpDir);
  assert.ok(wd, "Watchdog should be constructible");

  // didFire should be false initially
  assert.equal(wd.didFire, false, "didFire should be false initially");

  // Test arm/disarm cycle without timeout
  wd.arm(60000);
  wd.disarm();
  assert.equal(
    wd.didFire,
    false,
    "didFire should be false after disarm without timeout",
  );

  wd.shutdown();

  // Test V8 init: under Node.js on Unix, v8_init should succeed
  // (verified indirectly - the Watchdog constructor calls it)

  // Test runTarget with a normal synchronous target
  {
    const wd2 = new Watchdog(tmpDir);
    const target = (_data) => {
      // Just return - synchronous, no error
    };
    const result = wd2.runTarget(target, Buffer.from("hello"), 5000);
    assert.equal(result.exitKind, 0, "runTarget OK exitKind should be 0");
    assert.equal(result.error, undefined, "runTarget OK should have no error");
    wd2.shutdown();
  }

  // Test runTarget with a crashing target
  {
    const wd3 = new Watchdog(tmpDir);
    const target = (_data) => {
      throw new Error("test crash");
    };
    const result = wd3.runTarget(target, Buffer.from("crash"), 5000);
    assert.equal(result.exitKind, 1, "runTarget crash exitKind should be 1");
    assert.ok(
      result.error instanceof Error,
      "runTarget crash should have an error",
    );
    assert.equal(
      result.error.message,
      "test crash",
      "crash error message should match",
    );
    wd3.shutdown();
  }

  // Test runTarget with an async target (returns Promise)
  {
    const wd4 = new Watchdog(tmpDir);
    const target = async (_data) => {
      await Promise.resolve();
    };
    const result = wd4.runTarget(target, Buffer.from("async"), 5000);
    assert.equal(result.exitKind, 0, "runTarget async exitKind should be 0");
    assert.ok(
      result.result instanceof Promise,
      "runTarget async should return a Promise",
    );
    await result.result; // Await the promise to ensure it completes
    wd4.shutdown();
  }

  // Test runTarget with synchronous timeout (V8 TerminateExecution)
  // V8 shim is available on all platforms (Unix via dlsym, Windows via
  // GetProcAddress), so the infinite-loop timeout test runs everywhere.
  {
    const wd5 = new Watchdog(tmpDir);
    const target = (_data) => {
      for (;;) {
        /* infinite loop */
      }
    };
    const result = wd5.runTarget(target, Buffer.from("timeout"), 200);
    assert.equal(result.exitKind, 2, "runTarget timeout exitKind should be 2");
    assert.ok(
      result.error instanceof Error,
      "runTarget timeout should have an error",
    );
    assert.ok(
      result.error.message.includes("timed out"),
      `runTarget timeout error should mention timed out, got: ${result.error.message}`,
    );
    wd5.shutdown();
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("Watchdog smoke test passed!");
}

// ===== V8 shim availability =====
{
  // detect musl: glibc reports a version string, musl does not
  const isMusl =
    os.platform() === "linux" &&
    !process.report?.getReport()?.header?.glibcVersionRuntime;
  const available = v8ShimAvailable();
  console.log(
    `V8 shim available: ${available} (platform=${os.platform()}, musl=${isMusl})`,
  );

  if (os.platform() === "win32") {
    // On Windows, V8 symbols are resolved via GetProcAddress from node.exe.
    assert.equal(
      available,
      true,
      "v8ShimAvailable() should be true on Windows",
    );
  } else if (!isMusl) {
    // On glibc Linux and macOS, Node.js exports V8 symbols and dlsym
    // should resolve them. If this fails, the watchdog silently degrades
    // to _exit-only mode - this assertion catches that.
    assert.equal(
      available,
      true,
      "v8ShimAvailable() should be true on glibc Linux and macOS",
    );
  }
  // On musl Linux, V8 symbol availability depends on how Node.js was built.
  // Some musl builds (e.g. node:22-alpine) export V8 symbols; others don't.
  // Either value is acceptable - just log it.
  console.log("V8 shim availability test passed!");
}

// ===== Fuzzer smoke test summary =====
console.log("Smoke test passed!");
console.log(`  Total execs: ${stats.totalExecs}`);
console.log(`  Corpus size: ${stats.corpusSize}`);
console.log(`  Coverage edges: ${stats.coverageEdges}`);
console.log(`  Execs/sec: ${stats.execsPerSec.toFixed(0)}`);
console.log(`  Interesting inputs found: ${interestingCount}`);
console.log(`  Solutions: ${stats.solutionCount}`);
