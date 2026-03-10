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
    tier: 1,
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
    tier: 2,
  },
];

/** All known detector config keys (camelCase, matching FuzzOptions.detectors keys). */
export const KNOWN_DETECTOR_KEYS: ReadonlySet<string> = new Set(
  DETECTOR_REGISTRY.map((r) => r.key),
);

export class DetectorManager {
  private readonly detectors: Detector[];

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
   */
  endIteration(targetCompletedOk: boolean): VulnerabilityError | undefined {
    try {
      const stashed = drainStashedVulnerabilityError();
      if (targetCompletedOk) {
        try {
          const afterIterationResult = this.afterIteration();
          return afterIterationResult ?? stashed;
        } catch (e) {
          if (stashed) return stashed;
          throw e;
        }
      }
      return stashed;
    } finally {
      for (const detector of this.detectors) {
        detector.resetIteration();
      }
      setDetectorActive(false);
    }
  }

  private afterIteration(): VulnerabilityError | undefined {
    let firstVulnerabilityError: VulnerabilityError | undefined;
    let firstNonVulnerabilityError: unknown;

    for (const detector of this.detectors) {
      try {
        detector.afterIteration();
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
      detector.teardown();
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
// installDetectorModuleHooks() as an idempotent safety net — if setup.ts
// already ran, the second call is a no-op.

let _manager: DetectorManager | null = null;
let _installed = false;
let _installedConfig: DetectorConfig | undefined;

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
