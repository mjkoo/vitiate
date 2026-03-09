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
  /** Called once before fuzzing begins. Install hooks or initialize state. */
  setup(): void;
  /** Called before each target execution. Capture baseline state. */
  beforeIteration(): void;
  /** Called after target execution completes without throwing. Check for violations. */
  afterIteration(): void;
  /**
   * Called after every iteration regardless of exit kind.
   * Restores any per-iteration state captured by beforeIteration().
   * Must not throw.
   */
  resetIteration(): void;
  /** Called after fuzzing ends. Restore patched modules. */
  teardown(): void;
}
