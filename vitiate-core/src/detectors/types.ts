/**
 * Error type thrown by detectors when a vulnerability is found.
 * Treated as ExitKind.Crash by the fuzz engine - reuses the existing crash path.
 */
export class VulnerabilityError extends Error {
  readonly detectorName: string;
  readonly vulnerabilityType: string;
  readonly context: Record<string, unknown>;

  constructor(
    detectorName: string,
    vulnerabilityType: string,
    context: Record<string, unknown>,
    message?: string,
  ) {
    const summary =
      message ??
      `[${detectorName}] ${vulnerabilityType}: ${JSON.stringify(context)}`;
    super(summary);
    this.name = "VulnerabilityError";
    this.detectorName = detectorName;
    this.vulnerabilityType = vulnerabilityType;
    this.context = context;
  }
}

/**
 * Interface for bug detectors that hook into the fuzz loop lifecycle.
 */
export interface Detector {
  /** Unique kebab-case identifier (e.g., "prototype-pollution"). */
  readonly name: string;
  /** Tier 1 = default-on, Tier 2 = opt-in. */
  readonly tier: 1 | 2;
  /** Return dictionary tokens to pre-seed in the mutation dictionary. */
  getTokens(): Uint8Array[];
  /** Return seed inputs to pre-seed in the fuzzer corpus. */
  getSeeds(): Uint8Array[];
  /** Called once before fuzzing begins. Install hooks or initialize state. */
  setup(): void;
  /** Called before each target execution. Capture baseline state. */
  beforeIteration(): void;
  /** Called after target execution completes without throwing. Check for violations. */
  afterIteration(targetReturnValue?: unknown): void;
  /**
   * Called after every iteration regardless of exit kind.
   * Restores any per-iteration state captured by beforeIteration().
   * Must not throw.
   */
  resetIteration(): void;
  /** Called after fuzzing ends. Restore patched modules. */
  teardown(): void;
}
