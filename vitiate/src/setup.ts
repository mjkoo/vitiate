/**
 * Vitest setup file - auto-initializes globals on import.
 */
export { initGlobals } from "./globals.js";
import { initGlobals } from "./globals.js";
import {
  warnUnknownVitiateEnvVars,
  isFuzzingMode,
  isOptimizeMode,
  isMergeMode,
  isDebugMode,
  getCoverageMapSize,
  getCliOptions,
} from "./config.js";
import { installDetectorModuleHooks } from "./detectors/early-hooks.js";

// Auto-init when loaded as a Vitest setup file
await initGlobals();
warnUnknownVitiateEnvVars();

// Install detector hooks before test files are imported so that module
// property accesses (e.g., `import cp from "child_process"; cp.execSync()`)
// see the patched wrappers. Hooks are installed in all modes (fuzz and
// regression) but are gated by detectorActive — they are no-ops outside
// the iteration window set by beforeIteration()/afterIteration().
{
  const options = isFuzzingMode() ? getCliOptions() : {};
  installDetectorModuleHooks(options.detectors);
}

if (isDebugMode()) {
  function resolveMode(): string {
    if (isFuzzingMode()) return "fuzz";
    if (isOptimizeMode()) return "optimize";
    if (isMergeMode()) return "merge";
    return "regression";
  }
  process.stderr.write(`vitiate[debug]: mode=${resolveMode()}\n`);
  process.stderr.write(
    `vitiate[debug]: coverageMapSize=${getCoverageMapSize()}\n`,
  );
}
