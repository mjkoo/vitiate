/**
 * Utility for safely monkey-patching Node built-in module exports.
 *
 * Hooks are gated by an iteration-window flag: detector checks only run
 * between beforeIteration() and the end of target execution. Calls outside
 * this window pass through unconditionally.
 */
import { createRequire } from "node:module";
import { VulnerabilityError } from "./types.js";

const require = createRequire(import.meta.url);

/** Global flag controlling whether detector hooks are active. */
let detectorActive = false;

/**
 * Module-level stash for VulnerabilityErrors thrown by hook check callbacks.
 *
 * First-write-wins: only the first VulnerabilityError per iteration is stashed.
 * Subsequent hook fires within the same iteration see the slot is occupied and
 * skip the write. This matches the existing first-error-wins convention.
 */
let stashedVulnerabilityError: VulnerabilityError | undefined;

/**
 * Drain and return the stashed VulnerabilityError, clearing the slot.
 *
 * Returns the stashed error, or undefined if none. The slot is always cleared
 * after this call. DetectorManager is the only intended caller - it drains in
 * endIteration(), beforeIteration() (defensive discard), and teardown()
 * (defensive cleanup).
 */
export function drainStashedVulnerabilityError():
  | VulnerabilityError
  | undefined {
  const error = stashedVulnerabilityError;
  stashedVulnerabilityError = undefined;
  return error;
}

export function setDetectorActive(active: boolean): void {
  detectorActive = active;
}

export function isDetectorActive(): boolean {
  return detectorActive;
}

/**
 * Stash a VulnerabilityError (first-write-wins) and re-throw.
 *
 * For use by detectors that wrap globals or prototype methods directly
 * (not via installHook) but still need findings recoverable by
 * DetectorManager.endIteration() when the target swallows the thrown error.
 */
export function stashAndRethrow(error: unknown): never {
  if (error instanceof VulnerabilityError) {
    stashedVulnerabilityError ??= error;
  }
  throw error;
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
      try {
        check(...args);
      } catch (e) {
        stashAndRethrow(e);
      }
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
