// Verify the engine panic hook is installed at module load (module_init), not
// only in Watchdog/Fuzzer constructors: a panic in a napi entry called before
// either constructor must exit with the dedicated engine-panic exit code
// instead of aborting as SIGABRT (which the supervisor would misclassify as a
// crash in the target under test).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enginePanicExitCode } from "../index.js";

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexJs = path.join(pkgDir, "index.js");

// The child loads the addon and immediately calls the panicking test hook -
// deliberately without constructing Watchdog or Fuzzer first.
const child = spawnSync(
  process.execPath,
  ["-e", `require(${JSON.stringify(indexJs)}).__testEnginePanic()`],
  { encoding: "utf8" },
);

assert.equal(
  child.signal,
  null,
  `child should exit, not die from a signal (got ${child.signal})`,
);
assert.equal(
  child.status,
  enginePanicExitCode(),
  `pre-constructor engine panic should exit with the engine panic exit code, ` +
    `got status=${child.status} stderr=${child.stderr}`,
);
assert.match(
  child.stderr,
  /intentional test panic/,
  "panic message should be reported before exiting",
);

console.log("Panic-exit test passed!");
