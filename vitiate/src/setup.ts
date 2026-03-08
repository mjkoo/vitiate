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
} from "./config.js";

// Auto-init when loaded as a Vitest setup file
await initGlobals();
warnUnknownVitiateEnvVars();

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
