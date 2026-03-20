import { describe, it, expect, afterEach } from "vitest";
import { type Detector, VulnerabilityError } from "./types.js";
import {
  DetectorManager,
  installDetectorModuleHooks,
  getDetectorManager,
  resetDetectorHooks,
} from "./manager.js";
import {
  installHook,
  setDetectorActive,
  isDetectorActive,
  drainStashedVulnerabilityError,
} from "./module-hook.js";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const IS_WINDOWS = process.platform === "win32";
// path-traversal is Tier 2 on Windows (default-off), Tier 1 elsewhere.
const DEFAULT_TIER1_COUNT = IS_WINDOWS ? 2 : 3;

function noopDetector(overrides?: Partial<Detector>): Detector {
  return {
    name: "noop",
    tier: 1,
    getTokens: () => [],
    getSeeds: () => [],
    setup: () => {},
    beforeIteration: () => {},
    afterIteration: () => {},
    resetIteration: () => {},
    teardown: () => {},
    ...overrides,
  };
}

// ── DetectorManager ─────────────────────────────────────────────────────

describe("DetectorManager", () => {
  it("enables all Tier 1 detectors by default (undefined config)", () => {
    const manager = new DetectorManager(undefined);
    expect(manager.activeDetectorNames).not.toContain("prototype-pollution");
    expect(manager.activeDetectorNames).toContain("command-injection");
    expect(manager.activeDetectorNames).toContain("unsafe-eval");
    if (IS_WINDOWS) {
      expect(manager.activeDetectorNames).not.toContain("path-traversal");
    } else {
      expect(manager.activeDetectorNames).toContain("path-traversal");
    }
  });

  it("enables all Tier 1 detectors with empty config (no Tier 2)", () => {
    const manager = new DetectorManager({});
    expect(manager.activeDetectorNames).toHaveLength(DEFAULT_TIER1_COUNT);
    expect(manager.activeDetectorNames).not.toContain("prototype-pollution");
    expect(manager.activeDetectorNames).toContain("command-injection");
    expect(manager.activeDetectorNames).toContain("unsafe-eval");
    if (IS_WINDOWS) {
      expect(manager.activeDetectorNames).not.toContain("path-traversal");
    } else {
      expect(manager.activeDetectorNames).toContain("path-traversal");
    }
  });

  it("disables a detector when set to false", () => {
    const manager = new DetectorManager({
      prototypePollution: false,
    });
    expect(manager.activeDetectorNames).not.toContain("prototype-pollution");
    expect(manager.activeDetectorNames).toContain("command-injection");
    if (IS_WINDOWS) {
      expect(manager.activeDetectorNames).not.toContain("path-traversal");
    } else {
      expect(manager.activeDetectorNames).toContain("path-traversal");
    }
  });

  it("enables a detector when set to true", () => {
    const manager = new DetectorManager({
      prototypePollution: true,
    });
    expect(manager.activeDetectorNames).toContain("prototype-pollution");
  });

  it("passes options object to path traversal detector", () => {
    const manager = new DetectorManager({
      pathTraversal: { allowedPaths: ["/var/www"] },
    });
    expect(manager.activeDetectorNames).toContain("path-traversal");
  });

  it("silently ignores unknown detector keys", () => {
    // DetectorManager receives already-validated config from Valibot,
    // which strips unknown keys. But the manager itself also only
    // processes known registry entries.
    const manager = new DetectorManager({} as Record<string, unknown>);
    expect(manager.activeDetectorNames).toHaveLength(DEFAULT_TIER1_COUNT);
  });

  it("delegates lifecycle calls in registration order", () => {
    const calls: string[] = [];
    const mockDetector = (name: string): Detector => ({
      name,
      tier: 1,
      getTokens: () => [],
      getSeeds: () => [],
      setup: () => calls.push(`${name}.setup`),
      beforeIteration: () => calls.push(`${name}.before`),
      afterIteration: () => calls.push(`${name}.after`),
      resetIteration: () => calls.push(`${name}.reset`),
      teardown: () => calls.push(`${name}.teardown`),
    });

    // Access internals via subclass for testing
    const manager = new DetectorManager({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: false,
    });
    // Re-assign detectors for testing using the private field
    const detectors = [mockDetector("a"), mockDetector("b")];
    Object.defineProperty(manager, "detectors", { value: detectors });

    manager.setup();
    expect(calls).toEqual(["a.setup", "b.setup"]);

    calls.length = 0;
    manager.beforeIteration();
    expect(calls).toEqual(["a.before", "b.before"]);

    // endIteration(true) calls afterIteration then resetIteration
    calls.length = 0;
    manager.endIteration(true);
    expect(calls).toEqual(["a.after", "b.after", "a.reset", "b.reset"]);

    // endIteration(false) calls only resetIteration
    calls.length = 0;
    manager.beforeIteration();
    calls.length = 0;
    manager.endIteration(false);
    expect(calls).toEqual(["a.reset", "b.reset"]);

    calls.length = 0;
    manager.teardown();
    expect(calls).toEqual(["a.teardown", "b.teardown"]);
  });

  it("teardown runs even after errors during fuzzing", () => {
    const manager = new DetectorManager({});
    manager.setup();
    // Teardown should not throw even if called multiple times
    manager.teardown();
    manager.teardown();
  });

  it("returns no seeds when only Tier 1 detectors are active", () => {
    const manager = new DetectorManager({});
    const seeds = manager.getSeeds();
    expect(seeds).toEqual([]);
  });

  it("collects seeds from prototype pollution when enabled", () => {
    const manager = new DetectorManager({ prototypePollution: true });
    const seeds = manager.getSeeds();
    expect(seeds).toHaveLength(4);
    const seedStrings = seeds.map((s) => s.toString("utf8"));
    expect(seedStrings).toContain('{"__proto__":1}');
    expect(seedStrings).toContain('{"constructor":{"prototype":{}}}');
  });

  it("aggregates seeds from multiple detectors", () => {
    const manager = new DetectorManager({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: false,
    });
    const detectorA = noopDetector({
      name: "seed-a",
      getSeeds: () => [new Uint8Array([0x41]), new Uint8Array([0x42])],
    });
    const detectorB = noopDetector({
      name: "seed-b",
      getSeeds: () => [new Uint8Array([0x43])],
    });
    Object.defineProperty(manager, "detectors", {
      value: [detectorA, detectorB],
    });
    const seeds = manager.getSeeds();
    expect(seeds).toHaveLength(3);
    expect(seeds.map((s) => s.toString("utf8"))).toEqual(["A", "B", "C"]);
  });

  it("collects tokens from all active detectors", () => {
    const manager = new DetectorManager({});
    const tokens = manager.getTokens();
    expect(tokens.length).toBeGreaterThan(0);
    // Should contain tokens from all active Tier 1 detectors
    const tokenStrings = tokens.map((t) => t.toString("utf8"));
    expect(tokenStrings).not.toContain("__proto__"); // prototype pollution is Tier 2 (off by default)
    expect(tokenStrings).toContain("vitiate_cmd_inject"); // from command injection
    expect(tokenStrings).toContain("vitiate_eval_inject"); // from unsafe eval
    // Path traversal is tier 2 on Windows (not enabled by default config)
    if (process.platform !== "win32") {
      expect(tokenStrings).toContain("../"); // from path traversal
    }
  });
});

// ── endIteration tests ───────────────────────────────────────────────────

describe("DetectorManager.endIteration", () => {
  function createManagerWithMockDetectors(): {
    manager: DetectorManager;
    calls: string[];
  } {
    const calls: string[] = [];
    const mockDetector = (name: string): Detector => ({
      name,
      tier: 1,
      getTokens: () => [],
      getSeeds: () => [],
      setup: () => {},
      beforeIteration: () => calls.push(`${name}.before`),
      afterIteration: () => calls.push(`${name}.after`),
      resetIteration: () => calls.push(`${name}.reset`),
      teardown: () => {},
    });

    const manager = new DetectorManager({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: false,
    });
    const detectors = [mockDetector("a"), mockDetector("b")];
    Object.defineProperty(manager, "detectors", { value: detectors });

    return { manager, calls };
  }

  it("returns VulnerabilityError on Ok exit with finding", () => {
    const manager = new DetectorManager({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: false,
    });
    const throwingDetector: Detector = {
      name: "thrower",
      tier: 1,
      getTokens: () => [],
      getSeeds: () => [],
      setup: () => {},
      beforeIteration: () => {},
      afterIteration: () => {
        throw new VulnerabilityError("thrower", "Test", {});
      },
      resetIteration: () => {},
      teardown: () => {},
    };
    Object.defineProperty(manager, "detectors", {
      value: [throwingDetector],
    });

    manager.beforeIteration();
    const result = manager.endIteration(true);

    expect(result).toBeInstanceOf(VulnerabilityError);
    expect(isDetectorActive()).toBe(false);
  });

  it("returns undefined on Ok exit without finding", () => {
    const { manager } = createManagerWithMockDetectors();
    manager.beforeIteration();
    const result = manager.endIteration(true);
    expect(result).toBeUndefined();
    expect(isDetectorActive()).toBe(false);
  });

  it("skips checks on non-Ok exit but runs reset", () => {
    const { manager, calls } = createManagerWithMockDetectors();
    manager.beforeIteration();
    calls.length = 0;

    const result = manager.endIteration(false);

    expect(result).toBeUndefined();
    expect(calls).toEqual(["a.reset", "b.reset"]);
    expect(calls).not.toContain("a.after");
    expect(calls).not.toContain("b.after");
    expect(isDetectorActive()).toBe(false);
  });

  it("re-throws non-VulnerabilityError from afterIteration", () => {
    const manager = new DetectorManager({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: false,
    });
    const buggyDetector: Detector = {
      name: "buggy",
      tier: 1,
      getTokens: () => [],
      getSeeds: () => [],
      setup: () => {},
      beforeIteration: () => {},
      afterIteration: () => {
        throw new TypeError("detector bug");
      },
      resetIteration: () => {},
      teardown: () => {},
    };
    Object.defineProperty(manager, "detectors", {
      value: [buggyDetector],
    });

    manager.beforeIteration();
    expect(() => manager.endIteration(true)).toThrow(TypeError);
    expect(isDetectorActive()).toBe(false);
  });

  it("runs resetIteration even when afterIteration throws VulnerabilityError", () => {
    const calls: string[] = [];
    const manager = new DetectorManager({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: false,
    });
    const detector: Detector = {
      name: "test",
      tier: 1,
      getTokens: () => [],
      getSeeds: () => [],
      setup: () => {},
      beforeIteration: () => {},
      afterIteration: () => {
        calls.push("after");
        throw new VulnerabilityError("test", "Test", {});
      },
      resetIteration: () => calls.push("reset"),
      teardown: () => {},
    };
    Object.defineProperty(manager, "detectors", { value: [detector] });

    manager.beforeIteration();
    manager.endIteration(true);

    expect(calls).toEqual(["after", "reset"]);
  });
});

// ── Prototype pollution restored when afterIteration is not called ───────

describe("prototype pollution restored without afterIteration", () => {
  afterEach(() => {
    const proto = Object.prototype as Record<string, unknown>;
    delete proto["pollutedProp"];
  });

  it("resetIteration restores prototypes even when afterIteration is skipped (the bug fix)", () => {
    const manager = new DetectorManager({
      prototypePollution: true,
      commandInjection: false,
      pathTraversal: false,
    });
    manager.setup();

    manager.beforeIteration();
    (Object.prototype as Record<string, unknown>)["pollutedProp"] = "malicious";

    // Simulate a crash exit - endIteration(false) skips afterIteration but runs resetIteration
    const result = manager.endIteration(false);
    expect(result).toBeUndefined();

    // Prototype should be restored
    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, "pollutedProp"),
    ).toBe(false);

    manager.teardown();
  });
});

// ── endIteration stash integration tests ────────────────────────────────

describe("DetectorManager.endIteration stash integration", () => {
  function createManagerWithDetector(detector: Detector): DetectorManager {
    const manager = new DetectorManager({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: false,
    });
    // Guard: fail explicitly if the private field is renamed
    expect(manager).toHaveProperty("detectors");
    Object.defineProperty(manager, "detectors", { value: [detector] });
    return manager;
  }

  afterEach(() => {
    drainStashedVulnerabilityError();
    setDetectorActive(false);
  });

  it("Ok path with swallowed hook error surfaces stashed finding", () => {
    const stashed = new VulnerabilityError("hook", "Stashed", {});
    const hook = installHook("path", "join", () => {
      throw stashed;
    });
    setDetectorActive(true);

    // Simulate target catching the error (swallowing it)
    try {
      path.join("a", "b");
    } catch {
      // Target swallows the error
    }

    const manager = createManagerWithDetector(noopDetector());
    const result = manager.endIteration(true);

    expect(result).toBe(stashed);
    expect(isDetectorActive()).toBe(false);

    hook.restore();
  });

  it("Ok path with afterIteration finding takes priority over stash", () => {
    const stashed = new VulnerabilityError("hook", "Stashed", {});
    const afterIterationError = new VulnerabilityError(
      "detector",
      "AfterIteration",
      {},
    );

    const hook = installHook("path", "join", () => {
      throw stashed;
    });
    setDetectorActive(true);

    try {
      path.join("a", "b");
    } catch {
      // Target swallows
    }

    const manager = createManagerWithDetector(
      noopDetector({
        afterIteration: () => {
          throw afterIterationError;
        },
      }),
    );
    const result = manager.endIteration(true);

    expect(result).toBe(afterIterationError);
    expect(isDetectorActive()).toBe(false);

    hook.restore();
  });

  it("non-Ok path surfaces stashed finding", () => {
    const stashed = new VulnerabilityError("hook", "Stashed", {});
    const hook = installHook("path", "join", () => {
      throw stashed;
    });
    setDetectorActive(true);

    try {
      path.join("a", "b");
    } catch {
      // Target swallows
    }

    const manager = createManagerWithDetector(noopDetector());
    const result = manager.endIteration(false);

    expect(result).toBe(stashed);
    expect(isDetectorActive()).toBe(false);

    hook.restore();
  });

  it("non-Ok path without stash returns undefined", () => {
    const manager = createManagerWithDetector(noopDetector());
    manager.beforeIteration();
    const result = manager.endIteration(false);

    expect(result).toBeUndefined();
    expect(isDetectorActive()).toBe(false);
  });

  it("afterIteration throws non-VulnerabilityError with stash returns stashed finding", () => {
    const stashed = new VulnerabilityError("hook", "Stashed", {});
    const hook = installHook("path", "join", () => {
      throw stashed;
    });
    setDetectorActive(true);

    try {
      path.join("a", "b");
    } catch {
      // Target swallows
    }

    const resetCalled: boolean[] = [];
    const manager = createManagerWithDetector(
      noopDetector({
        afterIteration: () => {
          throw new TypeError("detector bug");
        },
        resetIteration: () => {
          resetCalled.push(true);
        },
      }),
    );
    const result = manager.endIteration(true);

    expect(result).toBe(stashed);
    expect(resetCalled).toHaveLength(1);
    expect(isDetectorActive()).toBe(false);

    hook.restore();
  });

  it("afterIteration throws non-VulnerabilityError without stash re-throws", () => {
    const resetCalled: boolean[] = [];
    const manager = createManagerWithDetector(
      noopDetector({
        afterIteration: () => {
          throw new TypeError("detector bug");
        },
        resetIteration: () => {
          resetCalled.push(true);
        },
      }),
    );
    manager.beforeIteration();

    expect(() => manager.endIteration(true)).toThrow(TypeError);
    expect(resetCalled).toHaveLength(1);
    expect(isDetectorActive()).toBe(false);
  });
});

// ── beforeIteration stash drain tests ───────────────────────────────────

describe("DetectorManager.beforeIteration stash drain", () => {
  afterEach(() => {
    drainStashedVulnerabilityError();
    setDetectorActive(false);
  });

  it("drains stale stash before activating detectors", () => {
    const stale = new VulnerabilityError("hook", "Stale", {});
    const hook = installHook("path", "join", () => {
      throw stale;
    });
    setDetectorActive(true);

    try {
      path.join("a", "b");
    } catch {
      // Simulate stale stash from prior iteration
    }

    hook.restore();

    // beforeIteration should drain the stale stash
    const manager = new DetectorManager({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: false,
    });
    manager.beforeIteration();

    // Stash should be empty now
    expect(drainStashedVulnerabilityError()).toBeUndefined();
    // Detectors should be active
    expect(isDetectorActive()).toBe(true);

    setDetectorActive(false);
  });
});

// ── teardown stash drain tests ──────────────────────────────────────────

describe("DetectorManager.teardown stash drain", () => {
  afterEach(() => {
    drainStashedVulnerabilityError();
    setDetectorActive(false);
  });

  it("drains stash before detector teardown (mid-iteration shutdown)", () => {
    const stashed = new VulnerabilityError("hook", "MidIteration", {});
    const hook = installHook("path", "join", () => {
      throw stashed;
    });
    setDetectorActive(true);

    try {
      path.join("a", "b");
    } catch {
      // Target swallows
    }

    hook.restore();

    const teardownCalled: boolean[] = [];
    const manager = new DetectorManager({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: false,
    });
    const detector: Detector = {
      name: "test",
      tier: 1,
      getTokens: () => [],
      getSeeds: () => [],
      setup: () => {},
      beforeIteration: () => {},
      afterIteration: () => {},
      resetIteration: () => {},
      teardown: () => {
        teardownCalled.push(true);
      },
    };
    Object.defineProperty(manager, "detectors", { value: [detector] });

    manager.teardown();

    // Stash should have been drained by teardown
    expect(drainStashedVulnerabilityError()).toBeUndefined();
    // Detector teardown should have been called
    expect(teardownCalled).toHaveLength(1);
    expect(isDetectorActive()).toBe(false);
  });
});

// ── DetectorManager: Tier 2 integration ─────────────────────────────────

describe("DetectorManager Tier 2 integration", () => {
  it("Tier 2 detectors are disabled by default", () => {
    const manager = new DetectorManager(undefined);
    expect(manager.activeDetectorNames).not.toContain("prototype-pollution");
    expect(manager.activeDetectorNames).not.toContain("redos");
    expect(manager.activeDetectorNames).not.toContain("ssrf");
  });

  it("Tier 2 detectors disabled with empty config", () => {
    const manager = new DetectorManager({});
    expect(manager.activeDetectorNames).not.toContain("prototype-pollution");
    expect(manager.activeDetectorNames).not.toContain("redos");
    expect(manager.activeDetectorNames).not.toContain("ssrf");
  });

  it("enables Tier 2 detector with boolean true", () => {
    const manager = new DetectorManager({ ssrf: true });
    manager.setup();
    try {
      expect(manager.activeDetectorNames).toContain("ssrf");
      // Tier 1 should still be active
      expect(manager.activeDetectorNames).toContain("command-injection");
    } finally {
      manager.teardown();
    }
  });

  it("enables Tier 2 detector with options object", () => {
    const manager = new DetectorManager({
      redos: { thresholdMs: 50 },
    });
    manager.setup();
    try {
      expect(manager.activeDetectorNames).toContain("redos");
    } finally {
      manager.teardown();
    }
  });

  it("enables ssrf with options object", () => {
    const manager = new DetectorManager({
      ssrf: { blockedHosts: ["internal.corp.example.com"] },
    });
    manager.setup();
    try {
      expect(manager.activeDetectorNames).toContain("ssrf");
    } finally {
      manager.teardown();
    }
  });

  it("explicit false disables Tier 2 detector", () => {
    const manager = new DetectorManager({
      ssrf: false,
      redos: false,
    });
    expect(manager.activeDetectorNames).not.toContain("ssrf");
    expect(manager.activeDetectorNames).not.toContain("redos");
  });
});

// ── installDetectorModuleHooks lifecycle ─────────────────────────────────

describe("installDetectorModuleHooks", () => {
  afterEach(() => {
    resetDetectorHooks();
    setDetectorActive(false);
  });

  it("creates a DetectorManager with default config", () => {
    installDetectorModuleHooks(undefined);
    const manager = getDetectorManager();
    expect(manager).toBeInstanceOf(DetectorManager);
    expect(manager!.activeDetectorNames).toContain("command-injection");
    expect(manager!.activeDetectorNames).toContain("unsafe-eval");
    if (IS_WINDOWS) {
      expect(manager!.activeDetectorNames).not.toContain("path-traversal");
    } else {
      expect(manager!.activeDetectorNames).toContain("path-traversal");
    }
    expect(manager!.activeDetectorNames).not.toContain("prototype-pollution");
  });

  it("is idempotent when called with the same config", () => {
    installDetectorModuleHooks(undefined);
    const first = getDetectorManager();

    installDetectorModuleHooks(undefined);
    const second = getDetectorManager();

    expect(second).toBe(first);
  });

  it("reconfigures when called with a different config", () => {
    installDetectorModuleHooks(undefined);
    const first = getDetectorManager();
    expect(first!.activeDetectorNames).toContain("command-injection");

    installDetectorModuleHooks({ commandInjection: false });
    const second = getDetectorManager();

    expect(second).not.toBe(first);
    expect(second!.activeDetectorNames).not.toContain("command-injection");
  });

  it("returns null before any installation", () => {
    expect(getDetectorManager()).toBeNull();
  });

  it("hooks are functional through require after installation", () => {
    installDetectorModuleHooks(undefined);
    setDetectorActive(true);

    const childProcess = require("child_process");
    expect(() => childProcess.execSync("echo vitiate_cmd_inject")).toThrow(
      VulnerabilityError,
    );
  });

  it("resetDetectorHooks tears down and clears the manager", () => {
    installDetectorModuleHooks(undefined);
    expect(getDetectorManager()).not.toBeNull();

    resetDetectorHooks();
    expect(getDetectorManager()).toBeNull();

    // Hooks are torn down - no VulnerabilityError thrown
    setDetectorActive(true);
    const childProcess = require("child_process");
    const fn = () => {
      try {
        childProcess.execSync("echo vitiate_cmd_inject", { timeout: 1000 });
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fn).not.toThrow();
  });
});

// ── endIteration return value forwarding ─────────────────────────────────

describe("DetectorManager.endIteration return value forwarding", () => {
  function createManagerWithReturnValueCapture(): {
    manager: DetectorManager;
    receivedValues: unknown[];
  } {
    const receivedValues: unknown[] = [];
    const capturingDetector: Detector = {
      name: "capture",
      tier: 1,
      getTokens: () => [],
      getSeeds: () => [],
      setup: () => {},
      beforeIteration: () => {},
      afterIteration: (targetReturnValue?: unknown) => {
        receivedValues.push(targetReturnValue);
      },
      resetIteration: () => {},
      teardown: () => {},
    };

    const manager = new DetectorManager({
      prototypePollution: false,
      commandInjection: false,
      pathTraversal: false,
    });
    Object.defineProperty(manager, "detectors", {
      value: [capturingDetector],
    });

    return { manager, receivedValues };
  }

  it("forwards return value to detector afterIteration", () => {
    const { manager, receivedValues } = createManagerWithReturnValueCapture();
    const testValue = { x: 42 };
    manager.beforeIteration();
    manager.endIteration(true, testValue);
    expect(receivedValues).toEqual([testValue]);
  });

  it("forwards undefined when called without second argument", () => {
    const { manager, receivedValues } = createManagerWithReturnValueCapture();
    manager.beforeIteration();
    manager.endIteration(true);
    expect(receivedValues).toEqual([undefined]);
  });

  it("does not call afterIteration on non-Ok exit", () => {
    const { manager, receivedValues } = createManagerWithReturnValueCapture();
    manager.beforeIteration();
    manager.endIteration(false);
    expect(receivedValues).toHaveLength(0);
  });
});
