import assert from "node:assert/strict";
import os from "node:os";
import {
  createCoverageMap,
  Fuzzer,
  Watchdog,
  ExitKind,
  IterationResult,
  cmplogGetSlotBuffer,
  cmplogGetWritePointer,
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

// ===== Slot buffer allocation and CmpLog pipeline tests =====

// ===== Slot buffer allocation tests =====

// Verify slot buffer and write pointer allocation, and cross-validate
// constants that must match between JS (globals.ts) and Rust (cmplog.rs).
{
  const SLOT_SIZE_JS = 80;
  const SLOT_BUFFER_SIZE_JS = 256 * 1024;
  const MAX_SLOTS_JS = (SLOT_BUFFER_SIZE_JS / SLOT_SIZE_JS) | 0;

  const slotBuffer = cmplogGetSlotBuffer();
  assert.ok(
    Buffer.isBuffer(slotBuffer),
    "cmplogGetSlotBuffer returns a Buffer",
  );
  assert.equal(
    slotBuffer.length,
    SLOT_BUFFER_SIZE_JS,
    `Slot buffer size mismatch: Rust returned ${slotBuffer.length}, JS expects ${SLOT_BUFFER_SIZE_JS}`,
  );
  assert.equal(
    (slotBuffer.length / SLOT_SIZE_JS) | 0,
    MAX_SLOTS_JS,
    `MAX_SLOTS mismatch: derived ${(slotBuffer.length / SLOT_SIZE_JS) | 0}, JS expects ${MAX_SLOTS_JS}`,
  );

  const writePointer = cmplogGetWritePointer();
  assert.ok(
    Buffer.isBuffer(writePointer),
    "cmplogGetWritePointer returns a Buffer",
  );
  assert.equal(writePointer.length, 4, "Write pointer is 4 bytes");

  console.log("Slot buffer allocation tests passed!");
}

// ===== CmpLog pipeline tests (via slot buffer) =====
// These tests also serve as cross-validation of the slot layout between JS and
// Rust: entries are written at specific byte offsets by JS, then deserialized by
// Rust's drain(). A mismatch in SLOT_SIZE or field offsets would produce wrong
// type tags, corrupted values, or incorrect entry counts.
{
  const SLOT_SIZE = 80;
  const slotBuffer = cmplogGetSlotBuffer();
  const writePointerBuf = cmplogGetWritePointer();
  const buf = new Uint8Array(
    slotBuffer.buffer,
    slotBuffer.byteOffset,
    slotBuffer.byteLength,
  );
  const view = new DataView(
    slotBuffer.buffer,
    slotBuffer.byteOffset,
    slotBuffer.byteLength,
  );
  const wptr = new Uint32Array(
    writePointerBuf.buffer,
    writePointerBuf.byteOffset,
    1,
  );

  const cmpMap = createCoverageMap(MAP_SIZE);
  const cmpFuzzer = new Fuzzer(cmpMap, { maxInputLen: 256 });

  cmpFuzzer.addSeed(Buffer.from("test"));

  // Verify no CmpLog entries initially.
  assert.equal(cmpFuzzer.cmpLogEntryCount, 0);

  // Run one iteration: write entries to slot buffer, then drain via reportResult.
  cmpFuzzer.getNextInput();

  // Write a string comparison to slot 0: "foo" === "bar", cmpId=1, opId=0
  {
    const off = 0;
    view.setUint32(off, 1, true); // cmpId
    buf[off + 4] = 0; // operatorId (===)
    buf[off + 5] = 2; // leftType = string
    buf[off + 6] = 2; // rightType = string
    const enc = new TextEncoder();
    const leftN = enc.encodeInto(
      "foo",
      buf.subarray(off + 8, off + 40),
    ).written;
    buf[off + 7] = leftN;
    const rightN = enc.encodeInto(
      "bar",
      buf.subarray(off + 41, off + 73),
    ).written;
    buf[off + 40] = rightN;
  }

  // Write a numeric comparison to slot 1: 42 === 100, cmpId=2, opId=0
  {
    const off = SLOT_SIZE;
    view.setUint32(off, 2, true); // cmpId
    buf[off + 4] = 0; // operatorId (===)
    buf[off + 5] = 1; // leftType = f64
    buf[off + 6] = 1; // rightType = f64
    view.setFloat64(off + 8, 42, true);
    view.setFloat64(off + 41, 100, true);
  }

  wptr[0] = 2; // 2 entries written

  cmpMap[0] = 1;
  cmpFuzzer.reportResult(ExitKind.Ok, 1000);

  // After reportResult, metadata should contain entries from slot buffer.
  // String pair: 1 entry (Bytes). Number pair: 2 entries (U8 + Bytes).
  assert.equal(
    cmpFuzzer.cmpLogEntryCount,
    3,
    `Expected 3 CmpLog entries (1 string + 2 number), got ${cmpFuzzer.cmpLogEntryCount}`,
  );

  // Verify entries are replaced on next iteration.
  cmpFuzzer.getNextInput();
  // Write "only" === "one" to slot 0
  {
    const off = 0;
    view.setUint32(off, 3, true);
    buf[off + 4] = 0;
    buf[off + 5] = 2;
    buf[off + 6] = 2;
    const enc = new TextEncoder();
    const leftN = enc.encodeInto(
      "only",
      buf.subarray(off + 8, off + 40),
    ).written;
    buf[off + 7] = leftN;
    const rightN = enc.encodeInto(
      "one",
      buf.subarray(off + 41, off + 73),
    ).written;
    buf[off + 40] = rightN;
  }
  wptr[0] = 1;

  cmpMap[1] = 1;
  cmpFuzzer.reportResult(ExitKind.Ok, 1000);
  assert.equal(
    cmpFuzzer.cmpLogEntryCount,
    1,
    `Expected 1 CmpLog entry after second iteration, got ${cmpFuzzer.cmpLogEntryCount}`,
  );

  // Verify empty slot buffer produces no entries.
  cmpFuzzer.getNextInput();
  wptr[0] = 0; // no entries written
  cmpMap[2] = 1;
  cmpFuzzer.reportResult(ExitKind.Ok, 1000);
  assert.equal(
    cmpFuzzer.cmpLogEntryCount,
    0,
    `Expected 0 CmpLog entries for empty buffer, got ${cmpFuzzer.cmpLogEntryCount}`,
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
