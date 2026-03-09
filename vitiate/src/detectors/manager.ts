/**
 * DetectorManager: orchestrates detector lifecycle and configuration.
 *
 * Resolves which detectors are active based on config (Tier 1 default-on,
 * Tier 2 default-off), instantiates them, and delegates lifecycle calls.
 */
import type { FuzzOptions } from "../config.js";
import type { Detector } from "./types.js";
import { VulnerabilityError } from "./vulnerability-error.js";
import { setDetectorActive } from "./module-hook.js";
import { PrototypePollutionDetector } from "./prototype-pollution.js";
import { CommandInjectionDetector } from "./command-injection.js";
import { PathTraversalDetector } from "./path-traversal.js";

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
          ? (options as { sandboxRoot?: string })
          : undefined;
      return new PathTraversalDetector(opts?.sandboxRoot);
    },
    tier: 1,
  },
];

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
    setDetectorActive(true);
    for (const detector of this.detectors) {
      detector.beforeIteration();
    }
  }

  /**
   * End the current iteration: run checks if target completed normally,
   * always reset state and deactivate the detector window.
   *
   * Returns the first VulnerabilityError found, or undefined.
   * Re-throws non-VulnerabilityError exceptions (detector bugs).
   */
  endIteration(targetCompletedOk: boolean): VulnerabilityError | undefined {
    try {
      if (targetCompletedOk) {
        return this.afterIteration();
      }
      return undefined;
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
    setDetectorActive(false);
    for (const detector of this.detectors) {
      detector.teardown();
    }
  }
}
