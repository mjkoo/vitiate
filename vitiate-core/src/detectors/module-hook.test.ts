import { describe, it, expect, afterEach, vi } from "vitest";
import { VulnerabilityError } from "./types.js";
import {
  installHook,
  setDetectorActive,
  drainStashedVulnerabilityError,
  stashAndRethrow,
} from "./module-hook.js";
import path from "node:path";

// ── VulnerabilityError ──────────────────────────────────────────────────

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

// ── Module hooking utility ──────────────────────────────────────────────

describe("module hooking utility", () => {
  afterEach(() => {
    drainStashedVulnerabilityError();
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

// ── stashAndRethrow ─────────────────────────────────────────────────────

describe("stashAndRethrow", () => {
  afterEach(() => {
    drainStashedVulnerabilityError();
  });

  it("stashes VulnerabilityError and re-throws", () => {
    const ve = new VulnerabilityError("test", "Test", {});
    expect(() => stashAndRethrow(ve)).toThrow(ve);
    expect(drainStashedVulnerabilityError()).toBe(ve);
  });

  it("preserves first-write-wins semantics", () => {
    const first = new VulnerabilityError("first", "First", {});
    const second = new VulnerabilityError("second", "Second", {});
    expect(() => stashAndRethrow(first)).toThrow(first);
    expect(() => stashAndRethrow(second)).toThrow(second);
    expect(drainStashedVulnerabilityError()).toBe(first);
  });

  it("re-throws non-VulnerabilityError without stashing", () => {
    const err = new Error("not a vulnerability");
    expect(() => stashAndRethrow(err)).toThrow(err);
    expect(drainStashedVulnerabilityError()).toBeUndefined();
  });
});
