import { describe, it, expect, afterEach, vi } from "vitest";
import { VulnerabilityError } from "./vulnerability-error.js";
import { DetectorManager } from "./manager.js";
import { installHook, setDetectorActive } from "./module-hook.js";
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

  it("enables all Tier 1 detectors with empty config", () => {
    const manager = new DetectorManager({});
    expect(manager.activeDetectorNames).toHaveLength(3);
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
      pathTraversal: { sandboxRoot: "/tmp/sandbox" },
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

    calls.length = 0;
    manager.afterIteration();
    expect(calls).toEqual(["a.after", "b.after"]);

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
    // Clean up any pollution from tests
    const proto = Object.prototype as Record<string, unknown>;
    delete proto["testProp"];
    delete proto["isAdmin"];
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

    // Clean up
    delete (Object.prototype as Record<string, unknown>)["testProp"];
  });

  it("ignores function-valued property additions", () => {
    detector.setup();
    detector.beforeIteration();
    (Object.prototype as Record<string, unknown>)["testPolyfill"] =
      function () {};
    detector.afterIteration(); // should NOT throw
    delete (Object.prototype as Record<string, unknown>)["testPolyfill"];
  });

  it("restores prototype state after detection", () => {
    detector.setup();
    detector.beforeIteration();
    (Object.prototype as Record<string, unknown>)["isAdmin"] = true;

    try {
      detector.afterIteration();
    } catch {
      // Expected
    }

    // The property should be cleaned up
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

  it("detects sandbox escape", () => {
    detector = new PathTraversalDetector("/tmp/sandbox");
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("/etc/passwd")).toThrow(VulnerabilityError);
  });

  it("allows paths within sandbox", () => {
    detector = new PathTraversalDetector(process.cwd());
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    // Reading a file within cwd should not throw VulnerabilityError
    const fn = () => {
      try {
        fs.readFileSync("./package.json");
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fn).not.toThrow();
  });

  it("detects null byte in path", () => {
    detector = new PathTraversalDetector(process.cwd());
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("safe.txt\x00../../etc/passwd")).toThrow(
      VulnerabilityError,
    );
  });

  it("checks both paths in dual-path functions", () => {
    detector = new PathTraversalDetector("/tmp/sandbox");
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    // Destination escapes sandbox
    expect(() =>
      fs.copyFileSync("/tmp/sandbox/safe.txt", "/etc/crontab"),
    ).toThrow(VulnerabilityError);
  });

  it("prevents prefix false positives", () => {
    detector = new PathTraversalDetector("/var/www");
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    // /var/www-evil is NOT inside /var/www
    expect(() => fs.readFileSync("/var/www-evil/data.txt")).toThrow(
      VulnerabilityError,
    );
  });

  it("returns static and config-dependent tokens", () => {
    detector = new PathTraversalDetector("/var/www/uploads");
    const tokens = detector.getTokens();
    const tokenStrings = tokens.map((t) => new TextDecoder().decode(t));
    expect(tokenStrings).toContain("../");
    expect(tokenStrings).toContain("../../");
    expect(tokenStrings).toContain("..\\");
    expect(tokenStrings).toContain("\x00");
    expect(tokenStrings).toContain("/var/www/uploads");
    // Depth-based traversal: /var/www/uploads has 3 components
    expect(tokenStrings).toContain("../../../etc/passwd");
  });
});
