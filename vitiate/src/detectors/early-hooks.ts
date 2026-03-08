/**
 * Detector hook lifecycle: install once, retrieve anywhere.
 *
 * Detector hooks monkey-patch Node built-in module exports (e.g.,
 * child_process.execSync). Hooks must be installed before fuzz targets
 * access hooked functions. User code should use default imports with
 * property access (`import cp from "child_process"; cp.execSync(...)`)
 * to ensure live binding to the patched wrapper.
 *
 * The canonical call site is setup.ts (Vitest's setup file, which runs
 * before test modules are imported). runFuzzLoop() also calls
 * installDetectorModuleHooks() as an idempotent safety net — if setup.ts
 * already ran, the second call is a no-op.
 */
import type { FuzzOptions } from "../config.js";
import { DetectorManager } from "./manager.js";

type DetectorConfig = FuzzOptions["detectors"];

let manager: DetectorManager | null = null;
let installed = false;
let installedConfigJson: string | undefined;

/**
 * Create the DetectorManager and install module hooks.
 *
 * Called from setup.ts (early, before ESM imports) and from
 * runFuzzLoop()/fuzz() (safety net). If already installed with the same
 * config, this is a no-op. If called with a different config, the old
 * manager is torn down and replaced — this allows per-test detector
 * configuration in regression mode (where setup.ts installs with default
 * config, then fuzz() overrides with user-specified config).
 */
export function installDetectorModuleHooks(config: DetectorConfig): void {
  const configJson = JSON.stringify(config) ?? "undefined";
  if (installed && configJson === installedConfigJson) return;

  if (manager) {
    manager.teardown();
  }

  installed = true;
  installedConfigJson = configJson;
  manager = new DetectorManager(config);
  manager.setup();
}

/**
 * Retrieve the DetectorManager created by installDetectorModuleHooks().
 *
 * Returns null only if installDetectorModuleHooks() was never called.
 */
export function getDetectorManager(): DetectorManager | null {
  return manager;
}

/**
 * Tear down the current DetectorManager and reset module state.
 *
 * Called at the end of fuzz loop and regression replay to ensure
 * hooks are cleaned up. Also used in tests.
 */
export function resetDetectorHooks(): void {
  if (manager) {
    manager.teardown();
  }
  manager = null;
  installed = false;
  installedConfigJson = undefined;
}
