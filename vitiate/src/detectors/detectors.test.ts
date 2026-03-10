import { describe, it, expect, afterEach, vi } from "vitest";
import { VulnerabilityError } from "./vulnerability-error.js";
import { DetectorManager } from "./manager.js";
import {
  installHook,
  setDetectorActive,
  isDetectorActive,
  drainStashedVulnerabilityError,
} from "./module-hook.js";
import {
  installDetectorModuleHooks,
  getDetectorManager,
  resetDetectorHooks,
} from "./early-hooks.js";
import { PrototypePollutionDetector } from "./prototype-pollution.js";
import { CommandInjectionDetector } from "./command-injection.js";
import { PathTraversalDetector } from "./path-traversal.js";
import type { Detector } from "./types.js";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── 10.1 VulnerabilityError ──────────────────────────────────────────────

describe("VulnerabilityError", () => {
  it("is instanceof Error", () => {
    const err = new VulnerabilityError("test-detector", "Test Vuln", {
      key: "value",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VulnerabilityError);
  });

  it("exposes detectorName, vulnerabilityType, and context", () => {
    const context = { function: "exec", command: "ls" };
    const err = new VulnerabilityError(
      "command-injection",
      "Command Injection",
      context,
    );
    expect(err.detectorName).toBe("command-injection");
    expect(err.vulnerabilityType).toBe("Command Injection");
    expect(err.context).toEqual(context);
  });

  it("has a descriptive message", () => {
    const err = new VulnerabilityError(
      "prototype-pollution",
      "Prototype Pollution",
      { property: "isAdmin" },
    );
    expect(err.message).toContain("prototype-pollution");
    expect(err.message).toContain("Prototype Pollution");
  });

  it("has a stack trace", () => {
    const err = new VulnerabilityError("test", "Test", {});
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("VulnerabilityError");
  });

  it("accepts a custom message", () => {
    const err = new VulnerabilityError("test", "Test", {}, "custom message");
    expect(err.message).toBe("custom message");
  });
});

// ── 10.2 DetectorManager ─────────────────────────────────────────────────

describe("DetectorManager", () => {
  it("enables all Tier 1 detectors by default (undefined config)", () => {
    const manager = new DetectorManager(undefined);
    expect(manager.activeDetectorNames).toContain("prototype-pollution");
    expect(manager.activeDetectorNames).toContain("command-injection");
    expect(manager.activeDetectorNames).toContain("path-traversal");
  });

  it("enables all Tier 1 detectors with empty config (no Tier 2)", () => {
    const manager = new DetectorManager({});
    expect(manager.activeDetectorNames).toHaveLength(3);
    expect(manager.activeDetectorNames).toContain("prototype-pollution");
    expect(manager.activeDetectorNames).toContain("command-injection");
    expect(manager.activeDetectorNames).toContain("path-traversal");
  });

  it("disables a detector when set to false", () => {
    const manager = new DetectorManager({
      prototypePollution: false,
    });
    expect(manager.activeDetectorNames).not.toContain("prototype-pollution");
    expect(manager.activeDetectorNames).toContain("command-injection");
    expect(manager.activeDetectorNames).toContain("path-traversal");
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
    expect(manager.activeDetectorNames).toHaveLength(3);
  });

  it("delegates lifecycle calls in registration order", () => {
    const calls: string[] = [];
    const mockDetector = (name: string): Detector => ({
      name,
      tier: 1,
      getTokens: () => [],
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

  it("collects tokens from all active detectors", () => {
    const manager = new DetectorManager({});
    const tokens = manager.getTokens();
    expect(tokens.length).toBeGreaterThan(0);
    // Should contain tokens from all three detectors
    const tokenStrings = tokens.map((t) => t.toString("utf8"));
    expect(tokenStrings).toContain("__proto__"); // from prototype pollution
    expect(tokenStrings).toContain("vitiate_cmd_inject"); // from command injection
    expect(tokenStrings).toContain("../"); // from path traversal
  });
});

// ── 10.3 Module hooking utility ──────────────────────────────────────────

describe("module hooking utility", () => {
  afterEach(() => {
    setDetectorActive(false);
  });

  it("hooks and restores a module function", () => {
    const check = vi.fn();
    const hook = installHook("path", "join", check);

    setDetectorActive(true);
    path.join("a", "b");
    expect(check).toHaveBeenCalledWith("a", "b");

    hook.restore();
    check.mockClear();
    path.join("a", "b");
    // After restore, check should not be called even when active
    expect(check).not.toHaveBeenCalled();
  });

  it("passes through when detectorActive is false", () => {
    const check = vi.fn();
    const hook = installHook("path", "basename", check);

    setDetectorActive(false);
    const result = path.basename("/foo/bar.txt");
    expect(check).not.toHaveBeenCalled();
    expect(result).toBe("bar.txt");

    hook.restore();
  });

  it("supports multiple hooks on different functions", () => {
    const check1 = vi.fn();
    const check2 = vi.fn();
    const hook1 = installHook("path", "join", check1);
    const hook2 = installHook("path", "resolve", check2);

    setDetectorActive(true);
    path.join("a", "b");
    path.resolve("c");

    expect(check1).toHaveBeenCalled();
    expect(check2).toHaveBeenCalled();

    hook1.restore();
    hook2.restore();
  });

  it("throws from check propagates to caller", () => {
    const hook = installHook("path", "join", () => {
      throw new VulnerabilityError("test", "Test", {});
    });

    setDetectorActive(true);
    expect(() => path.join("a", "b")).toThrow(VulnerabilityError);

    hook.restore();
  });
});

// ── 10.4 Prototype pollution detector ────────────────────────────────────

describe("PrototypePollutionDetector", () => {
  const detector = new PrototypePollutionDetector();

  afterEach(() => {
    // resetIteration restores prototype state; call before teardown clears snapshots.
    detector.resetIteration();
    detector.teardown();
  });

  it("detects property addition to Object.prototype", () => {
    detector.setup();
    detector.beforeIteration();
    (Object.prototype as Record<string, unknown>)["isAdmin"] = true;
    expect(() => detector.afterIteration()).toThrow(VulnerabilityError);
  });

  it("detects property modification on a prototype", () => {
    // Add a non-function property to test modification
    Object.defineProperty(Object.prototype, "testProp", {
      value: "original",
      writable: true,
      configurable: true,
      enumerable: false,
    });

    detector.setup();
    detector.beforeIteration();
    (Object.prototype as Record<string, unknown>)["testProp"] = "modified";
    expect(() => detector.afterIteration()).toThrow(VulnerabilityError);
  });

  it("ignores function-valued property additions", () => {
    detector.setup();
    detector.beforeIteration();
    (Object.prototype as Record<string, unknown>)["testPolyfill"] =
      function () {};
    detector.afterIteration(); // should NOT throw
  });

  it("restores prototype state via resetIteration", () => {
    detector.setup();
    detector.beforeIteration();
    (Object.prototype as Record<string, unknown>)["isAdmin"] = true;

    // afterIteration detects but does NOT restore
    try {
      detector.afterIteration();
    } catch {
      // Expected
    }

    // Property still present after afterIteration (no restoration)
    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, "isAdmin"),
    ).toBe(true);

    // resetIteration restores
    detector.resetIteration();
    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, "isAdmin"),
    ).toBe(false);
  });

  it("clean iteration produces no finding", () => {
    detector.setup();
    detector.beforeIteration();
    // No modifications
    expect(() => detector.afterIteration()).not.toThrow();
  });

  it("returns expected tokens", () => {
    const tokens = detector.getTokens();
    const tokenStrings = tokens.map((t) => new TextDecoder().decode(t));
    expect(tokenStrings).toContain("__proto__");
    expect(tokenStrings).toContain("constructor");
    expect(tokenStrings).toContain("prototype");
    expect(tokenStrings).toContain("__defineGetter__");
    expect(tokenStrings).toContain("__defineSetter__");
    expect(tokenStrings).toContain("__lookupGetter__");
    expect(tokenStrings).toContain("__lookupSetter__");
  });
});

// ── 10.5 Command injection detector ─────────────────────────────────────

describe("CommandInjectionDetector", () => {
  let detector: CommandInjectionDetector;

  afterEach(() => {
    detector?.teardown();
    setDetectorActive(false);
  });

  it("detects goal string in exec command", () => {
    detector = new CommandInjectionDetector();
    detector.setup();
    setDetectorActive(true);

    const childProcess = require("child_process");
    expect(() => childProcess.exec("ls; vitiate_cmd_inject")).toThrow(
      VulnerabilityError,
    );
  });

  it("detects goal string in execSync command", () => {
    detector = new CommandInjectionDetector();
    detector.setup();
    setDetectorActive(true);

    const childProcess = require("child_process");
    expect(() => childProcess.execSync("echo vitiate_cmd_inject")).toThrow(
      VulnerabilityError,
    );
  });

  it("detects goal string in spawn args array", () => {
    detector = new CommandInjectionDetector();
    detector.setup();
    setDetectorActive(true);

    const childProcess = require("child_process");
    expect(() =>
      childProcess.spawn("sh", ["-c", "vitiate_cmd_inject"]),
    ).toThrow(VulnerabilityError);
  });

  it("passes through when no goal string present", () => {
    detector = new CommandInjectionDetector();
    detector.setup();
    setDetectorActive(true);

    const childProcess = require("child_process");
    // exec with a safe command should not throw from the detector
    // (it may throw for other reasons like the command not existing,
    // but not VulnerabilityError)
    const fn = () => {
      try {
        childProcess.execSync("echo hello", { timeout: 1000 });
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
        // Other errors are fine (e.g., command not found)
      }
    };
    expect(fn).not.toThrow();
  });

  it("returns expected tokens", () => {
    detector = new CommandInjectionDetector();
    const tokens = detector.getTokens();
    const tokenStrings = tokens.map((t) => new TextDecoder().decode(t));
    expect(tokenStrings).toContain("vitiate_cmd_inject");
    expect(tokenStrings).toContain(";");
    expect(tokenStrings).toContain("|");
    expect(tokenStrings).toContain("&&");
    expect(tokenStrings).toContain("||");
    expect(tokenStrings).toContain("$(");
  });
});

// ── 10.6 Path traversal detector ─────────────────────────────────────────

describe("PathTraversalDetector", () => {
  let detector: PathTraversalDetector;

  afterEach(() => {
    detector?.teardown();
    setDetectorActive(false);
  });

  // ── Policy model tests ──

  it("default policy denies /etc/passwd", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("/etc/passwd")).toThrow(VulnerabilityError);
  });

  it("default policy allows arbitrary paths outside deniedPaths", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    const fn = () => {
      try {
        fs.readFileSync("/tmp/data.txt");
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fn).not.toThrow();
  });

  it("custom allowedPaths restricts access", () => {
    detector = new PathTraversalDetector(["/var/www"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("/etc/hosts")).toThrow(VulnerabilityError);
  });

  it("custom allowedPaths permits subtree", () => {
    detector = new PathTraversalDetector(["/var/www"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    const fn = () => {
      try {
        fs.readFileSync("/var/www/index.html");
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fn).not.toThrow();
  });

  it("deniedPaths overrides allowedPaths", () => {
    detector = new PathTraversalDetector(["/tmp"], ["/tmp/secrets"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("/tmp/secrets/key.pem")).toThrow(
      VulnerabilityError,
    );
  });

  it("accepts single-string deniedPaths (CLI path normalization)", () => {
    // CLI parseDetectorsFlag produces a raw string, not an array.
    // The constructor must normalize it rather than calling .map() on a string.
    detector = new PathTraversalDetector(undefined, "/tmp/secrets");
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("/tmp/secrets/key.pem")).toThrow(
      VulnerabilityError,
    );
  });

  it("accepts single-string allowedPaths (CLI path normalization)", () => {
    detector = new PathTraversalDetector("/var/www");
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("/etc/hosts")).toThrow(VulnerabilityError);
  });

  it("separator-aware prefix matching prevents false positives", () => {
    detector = new PathTraversalDetector(["/var/www"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    // /var/www-evil is NOT inside /var/www
    expect(() => fs.readFileSync("/var/www-evil/data.txt")).toThrow(
      VulnerabilityError,
    );
  });

  it("deniedPaths uses separator-aware prefix matching", () => {
    detector = new PathTraversalDetector(["/"], ["/etc/passwd"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    // /etc/passwdx should NOT match denied entry /etc/passwd
    const fn = () => {
      try {
        fs.readFileSync("/etc/passwdx");
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fn).not.toThrow();
  });

  it("detects null byte in path", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("safe.txt\x00../../etc/passwd")).toThrow(
      VulnerabilityError,
    );
  });

  it("null byte error context does not include sandboxRoot", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    try {
      fs.readFileSync("safe.txt\x00../../etc/passwd");
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(VulnerabilityError);
      const ve = e as VulnerabilityError;
      expect(ve.context).not.toHaveProperty("sandboxRoot");
      expect(ve.context).toHaveProperty("nullByte", true);
    }
  });

  it("checks both paths in dual-path functions", () => {
    detector = new PathTraversalDetector(["/"], ["/etc/crontab"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    // Destination is denied
    expect(() => fs.copyFileSync("safe.txt", "/etc/crontab")).toThrow(
      VulnerabilityError,
    );
  });

  it("error context includes function name, path, resolved path, and matched entry", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    try {
      fs.readFileSync("/etc/passwd");
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(VulnerabilityError);
      const ve = e as VulnerabilityError;
      expect(ve.context).toHaveProperty("function", "readFileSync");
      expect(ve.context).toHaveProperty("path", "/etc/passwd");
      expect(ve.context).toHaveProperty("resolvedPath");
      expect(ve.context).toHaveProperty("deniedEntry");
      expect(ve.context).not.toHaveProperty("sandboxRoot");
    }
  });

  // ── fs/promises hook tests ──

  it("fs/promises async readFile denied path throws VulnerabilityError", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fsPromises = require("fs/promises");
    expect(() => fsPromises.readFile("/etc/passwd")).toThrow(
      VulnerabilityError,
    );
  });

  it("fs/promises hooks are independent from fs hooks", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    const fsPromises = require("fs/promises");

    // Both should be hooked
    expect(() => fs.readFileSync("/etc/passwd")).toThrow(VulnerabilityError);
    expect(() => fsPromises.readFile("/etc/passwd")).toThrow(
      VulnerabilityError,
    );

    // Teardown restores both
    detector.teardown();
    setDetectorActive(true);

    // After teardown, neither should throw VulnerabilityError
    const fnFs = () => {
      try {
        fs.readFileSync("/etc/passwd");
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fnFs).not.toThrow();
  });

  it("restoring one module hook does not affect the other", () => {
    const check = () => {
      throw new VulnerabilityError("test", "Path Traversal", {});
    };
    const fsHook = installHook("fs", "readFileSync", check);
    const fsPromisesHook = installHook("fs/promises", "readFile", check);

    setDetectorActive(true);

    // Both hooks active
    const fs = require("fs");
    const fsPromises = require("fs/promises");
    expect(() => fs.readFileSync("/etc/passwd")).toThrow(VulnerabilityError);
    expect(() => fsPromises.readFile("/etc/passwd")).toThrow(
      VulnerabilityError,
    );

    // Restore only the fs hook
    fsHook.restore();

    // fs.readFileSync no longer throws VulnerabilityError
    const fnFs = () => {
      try {
        fs.readFileSync("/etc/passwd");
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fnFs).not.toThrow();

    // fs/promises.readFile still throws VulnerabilityError
    expect(() => fsPromises.readFile("/etc/passwd")).toThrow(
      VulnerabilityError,
    );

    // Cleanup
    fsPromisesHook.restore();
  });

  it("fs.promises.readFile is intercepted via shared object identity", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    // Node.js guarantees require("fs").promises === require("fs/promises").
    // Hooking fs/promises should also intercept fs.promises.readFile().
    const fs = require("fs");
    expect(() => fs.promises.readFile("/etc/passwd")).toThrow(
      VulnerabilityError,
    );
  });

  it("implicit deny context has resolvedPath but not deniedEntry", () => {
    detector = new PathTraversalDetector(["/var/www"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    try {
      fs.readFileSync("/etc/hosts");
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(VulnerabilityError);
      const ve = e as VulnerabilityError;
      expect(ve.context).toHaveProperty("resolvedPath");
      expect(ve.context).toHaveProperty("function", "readFileSync");
      expect(ve.context).toHaveProperty("path", "/etc/hosts");
      expect(ve.context).not.toHaveProperty("deniedEntry");
    }
  });

  // ── Token tests ──

  it("returns static traversal tokens and deniedPaths entries", () => {
    detector = new PathTraversalDetector();
    const tokens = detector.getTokens();
    const tokenStrings = tokens.map((t) => new TextDecoder().decode(t));
    expect(tokenStrings).toContain("../");
    expect(tokenStrings).toContain("../../");
    expect(tokenStrings).toContain("../../../");
    expect(tokenStrings).toContain("..\\");
    expect(tokenStrings).toContain("\x00");
    expect(tokenStrings).toContain("%2e%2e%2f");
    expect(tokenStrings).toContain("/etc/passwd");
  });

  it("does not include sandbox-path-derived tokens", () => {
    detector = new PathTraversalDetector(["/var/www/uploads"]);
    const tokens = detector.getTokens();
    const tokenStrings = tokens.map((t) => new TextDecoder().decode(t));
    // Should NOT include the allowedPaths entry or depth-computed chain
    expect(tokenStrings).not.toContain("/var/www/uploads");
    expect(tokenStrings).not.toContain("../../../etc/passwd");
  });

  it("custom deniedPaths entries appear in tokens", () => {
    detector = new PathTraversalDetector(undefined, [
      "/etc/passwd",
      "/proc/self/environ",
    ]);
    const tokens = detector.getTokens();
    const tokenStrings = tokens.map((t) => new TextDecoder().decode(t));
    expect(tokenStrings).toContain("/etc/passwd");
    expect(tokenStrings).toContain("/proc/self/environ");
  });
});

// ── resetIteration tests ──────────────────────────────────────────────────

describe("resetIteration", () => {
  afterEach(() => {
    // Safety net: ensure prototype pollution never leaks between tests.
    const proto = Object.prototype as Record<string, unknown>;
    delete proto["polluted1"];
    delete proto["polluted2"];
    delete proto["polluted"];
  });

  it("CommandInjectionDetector resetIteration is a no-op", () => {
    const detector = new CommandInjectionDetector();
    // Should not throw
    detector.resetIteration();
  });

  it("PathTraversalDetector resetIteration is a no-op", () => {
    const detector = new PathTraversalDetector();
    // Should not throw
    detector.resetIteration();
  });

  it("PrototypePollutionDetector resetIteration restores all prototypes", () => {
    const detector = new PrototypePollutionDetector();
    detector.setup();
    detector.beforeIteration();

    (Object.prototype as Record<string, unknown>)["polluted1"] = "a";
    (Object.prototype as Record<string, unknown>)["polluted2"] = "b";

    detector.resetIteration();

    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, "polluted1"),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, "polluted2"),
    ).toBe(false);
  });

  it("PrototypePollutionDetector resetIteration is idempotent", () => {
    const detector = new PrototypePollutionDetector();
    detector.setup();
    detector.beforeIteration();

    (Object.prototype as Record<string, unknown>)["polluted"] = "x";

    detector.resetIteration();
    // Second call is a no-op
    detector.resetIteration();

    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"),
    ).toBe(false);
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
      commandInjection: false,
      pathTraversal: false,
    });
    manager.setup();

    manager.beforeIteration();
    (Object.prototype as Record<string, unknown>)["pollutedProp"] = "malicious";

    // Simulate a crash exit — endIteration(false) skips afterIteration but runs resetIteration
    const result = manager.endIteration(false);
    expect(result).toBeUndefined();

    // Prototype should be restored
    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, "pollutedProp"),
    ).toBe(false);

    manager.teardown();
  });
});

// ── 10.7 installDetectorModuleHooks lifecycle ─────────────────────────────

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
    expect(manager!.activeDetectorNames).toContain("path-traversal");
    expect(manager!.activeDetectorNames).toContain("prototype-pollution");
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

    // Hooks are torn down — no VulnerabilityError thrown
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

// ── module-hook stash tests ─────────────────────────────────────────────

describe("module-hook stash", () => {
  afterEach(() => {
    drainStashedVulnerabilityError();
    setDetectorActive(false);
  });

  it("stashes VulnerabilityError on throw and re-throws it", () => {
    const vuln = new VulnerabilityError("test", "Test", {});
    const hook = installHook("path", "join", () => {
      throw vuln;
    });
    setDetectorActive(true);

    let thrown: unknown;
    try {
      path.join("a", "b");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(vuln);
    expect(drainStashedVulnerabilityError()).toBe(vuln);

    hook.restore();
  });

  it("first-write-wins: second VulnerabilityError does not overwrite stash", () => {
    const first = new VulnerabilityError("test", "First", {});
    const second = new VulnerabilityError("test", "Second", {});

    let callCount = 0;
    const hook = installHook("path", "join", () => {
      callCount++;
      throw callCount === 1 ? first : second;
    });
    setDetectorActive(true);

    // First call stashes `first`
    expect(() => path.join("a", "b")).toThrow(VulnerabilityError);
    // Second call throws `second` but stash retains `first`
    expect(() => path.join("c", "d")).toThrow(VulnerabilityError);

    expect(drainStashedVulnerabilityError()).toBe(first);

    hook.restore();
  });

  it("non-VulnerabilityError is not stashed", () => {
    const hook = installHook("path", "join", () => {
      throw new TypeError("detector bug");
    });
    setDetectorActive(true);

    expect(() => path.join("a", "b")).toThrow(TypeError);
    expect(drainStashedVulnerabilityError()).toBeUndefined();

    hook.restore();
  });

  it("drain returns and clears the stashed error", () => {
    const vuln = new VulnerabilityError("test", "Test", {});
    const hook = installHook("path", "join", () => {
      throw vuln;
    });
    setDetectorActive(true);

    expect(() => path.join("a", "b")).toThrow(VulnerabilityError);

    // First drain returns the error
    expect(drainStashedVulnerabilityError()).toBe(vuln);
    // Second drain returns undefined (slot cleared)
    expect(drainStashedVulnerabilityError()).toBeUndefined();

    hook.restore();
  });

  it("drain returns undefined when empty", () => {
    expect(drainStashedVulnerabilityError()).toBeUndefined();
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

  function noopDetector(overrides?: Partial<Detector>): Detector {
    return {
      name: "noop",
      tier: 1,
      getTokens: () => [],
      setup: () => {},
      beforeIteration: () => {},
      afterIteration: () => {},
      resetIteration: () => {},
      teardown: () => {},
      ...overrides,
    };
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
