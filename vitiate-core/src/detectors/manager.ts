/**
 * DetectorManager: orchestrates detector lifecycle and configuration.
 *
 * Resolves which detectors are active based on config (Tier 1 default-on,
 * Tier 2 default-off), instantiates them, and delegates lifecycle calls.
 */
import { isDeepStrictEqual } from "node:util";
import type { FuzzOptions } from "../config.js";
import { type Detector, VulnerabilityError } from "./types.js";
import {
  setDetectorActive,
  drainStashedVulnerabilityError,
} from "./module-hook.js";
import { PrototypePollutionDetector } from "./prototype-pollution.js";
import { CommandInjectionDetector } from "./command-injection.js";
import { PathTraversalDetector } from "./path-traversal.js";
import { RedosDetector } from "./redos.js";
import { SsrfDetector } from "./ssrf.js";
import { UnsafeEvalDetector } from "./unsafe-eval.js";

type DetectorConfig = FuzzOptions["detectors"];

interface DetectorRegistration {
  key: string;
  create: (options?: unknown) => Detector;
  tier: 1 | 2;
}

const DETECTOR_REGISTRY: DetectorRegistration[] = [
  {
    key: "prototypePollution",
    create: () => new PrototypePollutionDetector(),
    tier: 2,
  },
  {
    key: "commandInjection",
    create: () => new CommandInjectionDetector(),
    tier: 1,
  },
  {
    key: "pathTraversal",
    create: (options?: unknown) => {
      const opts =
        typeof options === "object" && options !== null
          ? (options as {
              allowedPaths?: string | string[];
              deniedPaths?: string | string[];
            })
          : undefined;
      return new PathTraversalDetector(opts?.allowedPaths, opts?.deniedPaths);
    },
    // Tier 2 on Windows: the default allowed-path policy (resolve("/") → current
    // drive root) cannot cover cross-drive access, UNC paths, or junctions,
    // making false positives likely without explicit user configuration.
    tier: process.platform === "win32" ? 2 : 1,
  },
  {
    key: "redos",
    create: (options?: unknown) => {
      const opts =
        typeof options === "object" && options !== null
          ? (options as { thresholdMs?: number })
          : undefined;
      return new RedosDetector(opts?.thresholdMs);
    },
    tier: 2,
  },
  {
    key: "ssrf",
    create: (options?: unknown) => {
      const opts =
        typeof options === "object" && options !== null
          ? (options as {
              blockedHosts?: string | string[];
              allowedHosts?: string | string[];
            })
          : undefined;
      return new SsrfDetector(opts?.blockedHosts, opts?.allowedHosts);
    },
    tier: 2,
  },
  {
    key: "unsafeEval",
    create: () => new UnsafeEvalDetector(),
    tier: 1,
  },
];

/** All known detector config keys (camelCase, matching FuzzOptions.detectors keys). */
export const KNOWN_DETECTOR_KEYS: ReadonlySet<string> = new Set(
  DETECTOR_REGISTRY.map((r) => r.key),
);

export class DetectorManager {
  private readonly detectors: Detector[];
  private readonly warnedLifecycleFailures = new Set<string>();

  constructor(config: DetectorConfig) {
    this.detectors = [];

    for (const reg of DETECTOR_REGISTRY) {
      const configValue =
        config?.[reg.key as keyof NonNullable<DetectorConfig>];

      // Explicit false = disabled
      if (configValue === false) continue;

      // Explicit true or options object = enabled
      if (
        configValue === true ||
        (typeof configValue === "object" && configValue !== null)
      ) {
        const options =
          typeof configValue === "object" ? configValue : undefined;
        this.detectors.push(reg.create(options));
        continue;
      }

      // Absent (undefined): use tier default
      if (configValue === undefined) {
        if (reg.tier === 1) {
          this.detectors.push(reg.create());
        }
        // Tier 2: skip
        continue;
      }
    }
  }

  /** Names of active detectors. */
  get activeDetectorNames(): string[] {
    return this.detectors.map((d) => d.name);
  }

  /** Collect tokens from all active detectors. */
  getTokens(): Buffer[] {
    const tokens: Buffer[] = [];
    for (const detector of this.detectors) {
      for (const token of detector.getTokens()) {
        tokens.push(Buffer.from(token));
      }
    }
    return tokens;
  }

  /** Collect seed inputs from all active detectors. */
  getSeeds(): Buffer[] {
    const seeds: Buffer[] = [];
    for (const detector of this.detectors) {
      for (const seed of detector.getSeeds()) {
        seeds.push(Buffer.from(seed));
      }
    }
    return seeds;
  }

  setup(): void {
    for (const detector of this.detectors) {
      detector.setup();
    }
  }

  beforeIteration(): void {
    // Defensive: drain any stale stash from a prior iteration whose
    // endIteration() was never called (e.g., unrelated exception in fuzz loop).
    drainStashedVulnerabilityError();
    setDetectorActive(true);
    for (const detector of this.detectors) {
      detector.beforeIteration();
    }
  }

  /**
   * End the current iteration: run afterIteration checks if the target
   * completed normally, always reset state and deactivate the detector window.
   *
   * On the Ok path, afterIteration() findings take priority over stashed
   * hook errors. On the non-Ok path, returns a stashed hook error if one
   * exists (recovering findings swallowed by target try/catch).
   *
   * Returns the first VulnerabilityError found, or undefined.
   * Re-throws non-VulnerabilityError exceptions (detector bugs), unless
   * a stashed VulnerabilityError exists (real finding takes priority).
   *
   * A resetIteration() that throws (contract violation - see Detector)
   * never aborts the result: the failure is logged to stderr (once per
   * detector), the remaining detectors still reset, and the detector
   * window is always deactivated. Unrestorable state is deliberately NOT
   * threaded into the return value: any prototype change that makes
   * restore fail is itself a descriptor diff, so afterIteration reports a
   * finding in the same iteration; residue without a finding requires the
   * target itself to have thrown - and in regression mode both cases
   * already abort the replay loop.
   */
  endIteration(
    targetCompletedOk: boolean,
    targetReturnValue?: unknown,
  ): VulnerabilityError | undefined {
    const stashed = drainStashedVulnerabilityError();
    let result: VulnerabilityError | undefined;
    let pendingError: unknown;
    let hasPendingError = false;

    if (targetCompletedOk) {
      try {
        result = this.afterIteration(targetReturnValue) ?? stashed;
      } catch (e) {
        if (stashed) {
          result = stashed;
        } else {
          pendingError = e;
          hasPendingError = true;
        }
      }
    } else {
      result = stashed;
    }

    for (const detector of this.detectors) {
      try {
        detector.resetIteration();
      } catch (e) {
        this.warnLifecycleFailure(detector.name, "resetIteration", e);
      }
    }
    setDetectorActive(false);

    if (hasPendingError) throw pendingError;
    return result;
  }

  /**
   * Warn (once per detector per manager) that a detector lifecycle hook
   * violated its no-throw contract.
   */
  private warnLifecycleFailure(
    detectorName: string,
    hook: "resetIteration" | "teardown",
    error: unknown,
  ): void {
    const dedupKey = `${detectorName}.${hook}`;
    if (this.warnedLifecycleFailures.has(dedupKey)) return;
    this.warnedLifecycleFailures.add(dedupKey);
    const msg = error instanceof Error ? error.message : String(error);
    // A throwing lifecycle hook is a detector bug; the message alone is
    // often undiagnosable, so include the top stack frame.
    const frame =
      error instanceof Error ? error.stack?.split("\n")[1]?.trim() : undefined;
    process.stderr.write(
      `vitiate: warning: detector "${detectorName}" threw from ${hook}() ` +
        `(detectors must not throw here; state may be inconsistent): ${msg}` +
        `${frame ? ` (${frame})` : ""}\n`,
    );
  }

  private afterIteration(
    targetReturnValue?: unknown,
  ): VulnerabilityError | undefined {
    let firstVulnerabilityError: VulnerabilityError | undefined;
    let firstNonVulnerabilityError: unknown;

    for (const detector of this.detectors) {
      try {
        detector.afterIteration(targetReturnValue);
      } catch (e) {
        if (e instanceof VulnerabilityError) {
          firstVulnerabilityError ??= e;
        } else {
          firstNonVulnerabilityError ??= e;
        }
      }
    }

    if (firstNonVulnerabilityError !== undefined) {
      throw firstNonVulnerabilityError;
    }

    return firstVulnerabilityError;
  }

  teardown(): void {
    // Defensive: drain stash before detector teardown in case endIteration()
    // was never called (mid-iteration shutdown).
    drainStashedVulnerabilityError();
    setDetectorActive(false);
    for (const detector of this.detectors) {
      try {
        detector.teardown();
      } catch (e) {
        this.warnLifecycleFailure(detector.name, "teardown", e);
      }
    }
  }
}

// ── Detector hook lifecycle: install once, retrieve anywhere ─────────────
//
// Detector hooks monkey-patch Node built-in module exports (e.g.,
// child_process.execSync). Hooks must be installed before fuzz targets
// access hooked functions. User code should use default imports with
// property access (`import cp from "child_process"; cp.execSync(...)`)
// to ensure live binding to the patched wrapper.
//
// The canonical call site is setup.ts (Vitest's setup file, which runs
// before test modules are imported). runFuzzLoop() also calls
// installDetectorModuleHooks() as an idempotent safety net - if setup.ts
// already ran, the second call is a no-op.

let _manager: DetectorManager | null = null;
let _installed = false;
let _installedConfig: DetectorConfig | undefined;

/**
 * Create the DetectorManager and install module hooks.
 *
 * Idempotent: safe to call multiple times. If already installed with the
 * same config, this is a no-op. If called with a different config, the old
 * manager is torn down and replaced.
 *
 * Three call sites, each with a distinct intent:
 *
 * - **setup.ts** (Vitest setup file): early install before ESM imports so
 *   user code captures the patched module wrappers via live bindings.
 * - **loop.ts** (runFuzzLoop): idempotent safety net re-call - no-op if
 *   setup.ts already installed with the same config.
 * - **fuzz.ts** (regression mode): per-test reconfiguration - tears down
 *   and replaces the manager when the user's fuzz() call specifies a
 *   different detector config than the default from setup.ts.
 */
export function installDetectorModuleHooks(config: DetectorConfig): void {
  if (_installed && isDeepStrictEqual(config, _installedConfig)) return;

  if (_manager) {
    _manager.teardown();
  }

  _installed = true;
  _installedConfig = structuredClone(config);
  _manager = new DetectorManager(config);
  _manager.setup();
}

/**
 * Retrieve the DetectorManager created by installDetectorModuleHooks().
 *
 * Returns null only if installDetectorModuleHooks() was never called.
 */
export function getDetectorManager(): DetectorManager | null {
  return _manager;
}

/**
 * Tear down the current DetectorManager and reset module state.
 *
 * Called at the end of fuzz loop and regression replay to ensure
 * hooks are cleaned up. Also used in tests.
 */
export function resetDetectorHooks(): void {
  if (_manager) {
    _manager.teardown();
  }
  _manager = null;
  _installed = false;
  _installedConfig = undefined;
}
