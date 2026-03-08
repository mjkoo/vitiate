/**
 * Utility for safely monkey-patching Node built-in module exports.
 *
 * Hooks are gated by an iteration-window flag: detector checks only run
 * between beforeIteration() and the end of target execution. Calls outside
 * this window pass through unconditionally.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Global flag controlling whether detector hooks are active. */
let detectorActive = false;

export function setDetectorActive(active: boolean): void {
  detectorActive = active;
}

export function isDetectorActive(): boolean {
  return detectorActive;
}

/**
 * A single installed hook on a module export.
 * Stores the original function for restoration.
 */
export interface ModuleHook {
  moduleSpecifier: string;
  functionName: string;
  restore(): void;
}

/**
 * Install a hook on a Node built-in module export.
 *
 * The `check` callback receives the original arguments. If it throws
 * (e.g., VulnerabilityError), the original function is never called.
 * If it returns normally, the original function is called with the
 * same arguments.
 *
 * The check is only invoked when `detectorActive` is true (inside the
 * iteration window). Outside that window, calls pass through directly.
 */
export function installHook(
  moduleSpecifier: string,
  functionName: string,
  check: (...args: unknown[]) => void,
): ModuleHook {
  const mod = require(moduleSpecifier) as Record<string, unknown>;
  const original = mod[functionName];

  if (typeof original !== "function") {
    throw new Error(
      `Cannot hook ${moduleSpecifier}.${functionName}: not a function`,
    );
  }

  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    if (detectorActive) {
      check(...args);
    }
    return (original as (...args: unknown[]) => unknown).apply(this, args);
  };

  // Preserve function name and length for compatibility
  Object.defineProperty(wrapper, "name", { value: original.name });
  Object.defineProperty(wrapper, "length", {
    value: (original as (...args: unknown[]) => unknown).length,
  });

  mod[functionName] = wrapper;

  return {
    moduleSpecifier,
    functionName,
    restore() {
      mod[functionName] = original;
    },
  };
}
