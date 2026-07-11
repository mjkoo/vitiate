import { describe, it, expect, afterEach, vi } from "vitest";
import { VulnerabilityError } from "./types.js";
import {
  PrototypePollutionDetector,
  containsPrototypeReference,
} from "./prototype-pollution.js";

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

  it("detects property deletion from a prototype", () => {
    // Add a configurable non-function property so it gets snapshotted
    Object.defineProperty(Object.prototype, "deletableTestProp", {
      value: 42,
      writable: true,
      configurable: true,
      enumerable: false,
    });

    detector.setup();
    detector.beforeIteration();

    // Delete the property during the iteration
    delete (Object.prototype as Record<string, unknown>)["deletableTestProp"];

    expect(() => detector.afterIteration()).toThrow(VulnerabilityError);
  });

  it("detects symbol key addition to a prototype", () => {
    const sym = Symbol("pollution");
    detector.setup();
    detector.beforeIteration();

    Object.defineProperty(Object.prototype, sym, {
      value: "evil",
      configurable: true,
    });

    try {
      expect(() => detector.afterIteration()).toThrow(VulnerabilityError);
    } finally {
      // Cleanup: resetIteration will handle this, but be safe
      delete (Object.prototype as Record<symbol, unknown>)[sym];
    }
  });

  it("restores symbol key additions via resetIteration", () => {
    const sym = Symbol("restore-test");
    detector.setup();
    detector.beforeIteration();

    Object.defineProperty(Object.prototype, sym, {
      value: "evil",
      configurable: true,
    });

    detector.resetIteration();

    expect(Object.getOwnPropertyDescriptor(Object.prototype, sym)).toBe(
      undefined,
    );
  });

  it("detects accessor property addition", () => {
    detector.setup();
    detector.beforeIteration();

    Object.defineProperty(Object.prototype, "hackedGetter", {
      get: () => "pwned",
      configurable: true,
    });

    try {
      expect(() => detector.afterIteration()).toThrow(VulnerabilityError);
    } finally {
      delete (Object.prototype as Record<string, unknown>)["hackedGetter"];
    }
  });

  it("detects data-to-accessor conversion", () => {
    // Start with a data property
    Object.defineProperty(Object.prototype, "convertMe", {
      value: "original",
      writable: true,
      configurable: true,
      enumerable: false,
    });

    detector.setup();
    detector.beforeIteration();

    // Convert to accessor
    Object.defineProperty(Object.prototype, "convertMe", {
      get: () => "hijacked",
      configurable: true,
    });

    expect(() => detector.afterIteration()).toThrow(VulnerabilityError);
  });

  it("detects pollution on Array.prototype", () => {
    detector.setup();
    detector.beforeIteration();
    (Array.prototype as unknown as Record<string, unknown>)["polluted"] = true;
    try {
      expect(() => detector.afterIteration()).toThrow(VulnerabilityError);
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)[
        "polluted"
      ];
    }
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

// ── function-valued prototype pollution ─────────────────────────────────
//
// The pristine table (captured once on the first beforeIteration) covers
// function-valued properties, so planting, replacing, or deleting a built-in
// method is now detected and restored. Pre-existing methods/polyfills present
// when the table is captured are the baseline and are never flagged. Each
// test uses a fresh detector and saves/restores any real built-in it touches.

describe("PrototypePollutionDetector function-valued pollution", () => {
  it("ignores a pre-existing function-valued property (polyfill)", () => {
    const d = new PrototypePollutionDetector();
    // Installed BEFORE the pristine table is captured -> part of the baseline.
    (Object.prototype as Record<string, unknown>)["preexistingPolyfill"] =
      function () {};
    try {
      d.setup();
      d.beforeIteration();
      expect(() => d.afterIteration()).not.toThrow();
      d.resetIteration();
      d.teardown();
    } finally {
      delete (Object.prototype as Record<string, unknown>)[
        "preexistingPolyfill"
      ];
    }
  });

  it("detects and restores a newly-added function property", () => {
    const d = new PrototypePollutionDetector();
    d.setup();
    d.beforeIteration();
    (Object.prototype as Record<string, unknown>)["toJSON"] = () => ({});
    try {
      let thrown: VulnerabilityError | undefined;
      try {
        d.afterIteration();
      } catch (e) {
        thrown = e as VulnerabilityError;
      }
      expect(thrown).toBeInstanceOf(VulnerabilityError);
      expect(thrown?.context["changeType"]).toBe("added");
      expect(thrown?.context["isAccessor"]).toBe(false);
      d.resetIteration();
      expect(
        Object.prototype.hasOwnProperty.call(Object.prototype, "toJSON"),
      ).toBe(false);
    } finally {
      d.teardown();
      delete (Object.prototype as Record<string, unknown>)["toJSON"];
    }
  });

  it("detects and restores a replaced built-in method", () => {
    const d = new PrototypePollutionDetector();
    const arr = Array.prototype as unknown as Record<string, unknown>;
    const originalMap = Array.prototype.map;
    d.setup();
    d.beforeIteration();
    arr["map"] = function () {
      return [];
    };
    try {
      let thrown: VulnerabilityError | undefined;
      try {
        d.afterIteration();
      } catch (e) {
        thrown = e as VulnerabilityError;
      }
      expect(thrown).toBeInstanceOf(VulnerabilityError);
      expect(thrown?.context["changeType"]).toBe("modified");
      d.resetIteration();
      expect(Array.prototype.map).toBe(originalMap);
    } finally {
      d.teardown();
      arr["map"] = originalMap;
    }
  });

  it("detects and restores a deleted built-in method", () => {
    const d = new PrototypePollutionDetector();
    const arr = Array.prototype as unknown as Record<string, unknown>;
    const originalPush = Array.prototype.push;
    d.setup();
    d.beforeIteration();
    delete arr["push"];
    // Capture results while `push` is deleted, but restore it before running
    // any `expect(...)` - assertions may use `Array.prototype.push` internally,
    // and only the detector calls (which do not push) run in the guarded window.
    let thrown: VulnerabilityError | undefined;
    let restoredPush: unknown;
    try {
      try {
        d.afterIteration();
      } catch (e) {
        thrown = e as VulnerabilityError;
      }
      d.resetIteration();
      restoredPush = Array.prototype.push;
    } finally {
      d.teardown();
      arr["push"] = originalPush;
    }
    expect(thrown).toBeInstanceOf(VulnerabilityError);
    expect(thrown?.context["changeType"]).toBe("deleted");
    expect(restoredPush).toBe(originalPush);
  });

  it("detects and restores a replaced symbol-keyed function", () => {
    // A custom symbol-keyed method installed as baseline, then replaced. We
    // avoid replacing a real built-in symbol method (e.g. Symbol.iterator),
    // since that would sabotage the detector's own array iteration.
    const sym = Symbol("customMethod");
    const proto = Object.prototype as unknown as Record<symbol, () => unknown>;
    const original = function original(): void {};
    Object.defineProperty(Object.prototype, sym, {
      value: original,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    const d = new PrototypePollutionDetector();
    d.setup();
    d.beforeIteration(); // captures sym -> original into the pristine table
    proto[sym] = function replacement(): void {};
    try {
      let thrown: VulnerabilityError | undefined;
      try {
        d.afterIteration();
      } catch (e) {
        thrown = e as VulnerabilityError;
      }
      expect(thrown).toBeInstanceOf(VulnerabilityError);
      expect(thrown?.context["changeType"]).toBe("modified");
      d.resetIteration();
      expect(proto[sym]).toBe(original);
    } finally {
      d.teardown();
      delete proto[sym];
    }
  });

  it("does not re-baseline on a later beforeIteration (captured latch)", () => {
    const d = new PrototypePollutionDetector();
    d.setup();
    d.beforeIteration(); // captures the pristine table
    d.afterIteration(); // clean
    // A mutation introduced AFTER the pristine capture must still be a finding
    // on the next iteration - beforeIteration must not re-baseline.
    (Object.prototype as Record<string, unknown>)["latched"] = () => {};
    d.beforeIteration();
    try {
      let thrown: VulnerabilityError | undefined;
      try {
        d.afterIteration();
      } catch (e) {
        thrown = e as VulnerabilityError;
      }
      expect(thrown).toBeInstanceOf(VulnerabilityError);
      expect(thrown?.context["changeType"]).toBe("added");
    } finally {
      d.resetIteration();
      d.teardown();
      delete (Object.prototype as Record<string, unknown>)["latched"];
    }
  });
});

// ── resetIteration tests ────────────────────────────────────────────────

describe("PrototypePollutionDetector resetIteration", () => {
  afterEach(() => {
    // Safety net: ensure prototype pollution never leaks between tests.
    const proto = Object.prototype as Record<string, unknown>;
    delete proto["polluted1"];
    delete proto["polluted2"];
    delete proto["polluted"];
  });

  it("restores all prototypes", () => {
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

  it("is idempotent", () => {
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

// ── containsPrototypeReference tests ────────────────────────────────────

describe("containsPrototypeReference", () => {
  it("detects direct prototype at root", () => {
    const result = containsPrototypeReference(Array.prototype);
    expect(result).toEqual({ prototype: "Array.prototype", keyPath: "" });
  });

  it("detects prototype nested 1 deep", () => {
    const result = containsPrototypeReference({ x: Array.prototype });
    expect(result).toEqual({ prototype: "Array.prototype", keyPath: "x" });
  });

  it("detects prototype nested 3 deep (max depth)", () => {
    const result = containsPrototypeReference({
      a: { b: { c: Object.prototype } },
    });
    expect(result).toEqual({ prototype: "Object.prototype", keyPath: "a.b.c" });
  });

  it("detects prototype inside an array", () => {
    const result = containsPrototypeReference([Array.prototype]);
    expect(result).toEqual({ prototype: "Array.prototype", keyPath: "0" });
  });

  it("returns undefined for plain object", () => {
    expect(containsPrototypeReference({ x: 1, y: "hello" })).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(containsPrototypeReference(undefined)).toBeUndefined();
  });

  it("returns undefined for primitive values", () => {
    expect(containsPrototypeReference(42)).toBeUndefined();
    expect(containsPrototypeReference("hello")).toBeUndefined();
    expect(containsPrototypeReference(true)).toBeUndefined();
    expect(containsPrototypeReference(null)).toBeUndefined();
  });

  it("does not detect prototype at depth 4 (beyond limit)", () => {
    const result = containsPrototypeReference({
      a: { b: { c: { d: Object.prototype } } },
    });
    expect(result).toBeUndefined();
  });

  it("handles circular references without infinite loop", () => {
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    expect(containsPrototypeReference(obj)).toBeUndefined();
  });

  it("detects leak in object with circular references", () => {
    const obj: Record<string, unknown> = { a: Array.prototype };
    obj["self"] = obj;
    const result = containsPrototypeReference(obj);
    expect(result).toEqual({ prototype: "Array.prototype", keyPath: "a" });
  });

  it("ignores symbol-keyed properties", () => {
    const sym = Symbol("key");
    const obj = Object.create(null);
    Object.defineProperty(obj, sym, {
      value: Object.prototype,
      enumerable: true,
    });
    expect(containsPrototypeReference(obj)).toBeUndefined();
  });

  it("ignores non-enumerable properties", () => {
    const obj = Object.create(null);
    Object.defineProperty(obj, "hidden", {
      value: Object.prototype,
      enumerable: false,
    });
    expect(containsPrototypeReference(obj)).toBeUndefined();
  });

  it("reports first encountered leak when multiple exist", () => {
    const result = containsPrototypeReference({
      a: Array.prototype,
      b: Object.prototype,
    });
    // Object.keys() iterates in insertion order; first key wins
    expect(result).toEqual({ prototype: "Array.prototype", keyPath: "a" });
  });

  it("skips unwalkable subtrees from exotic objects", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    // Revoked proxy child is skipped, no leak detected
    expect(containsPrototypeReference({ x: revoked.proxy })).toBeUndefined();
  });

  it("detects leak alongside unwalkable sibling", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const result = containsPrototypeReference({
      x: revoked.proxy,
      y: Array.prototype,
    });
    expect(result).toEqual({ prototype: "Array.prototype", keyPath: "y" });
  });

  it("does not detect prototype inside Map entries", () => {
    expect(
      containsPrototypeReference(new Map([["x", Array.prototype]])),
    ).toBeUndefined();
  });

  it("does not detect prototype inside Set entries", () => {
    expect(
      containsPrototypeReference(new Set([Object.prototype])),
    ).toBeUndefined();
  });
});

// ── PrototypePollutionDetector.afterIteration with return value ──────────

describe("PrototypePollutionDetector.afterIteration with return value", () => {
  const detector = new PrototypePollutionDetector();

  afterEach(() => {
    detector.resetIteration();
    detector.teardown();
  });

  it("detects leaked reference in return value", () => {
    detector.setup();
    detector.beforeIteration();
    expect(() => detector.afterIteration({ x: Array.prototype })).toThrow(
      VulnerabilityError,
    );
  });

  it("leaked reference error has correct context", () => {
    detector.setup();
    detector.beforeIteration();
    try {
      detector.afterIteration({ x: Array.prototype });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VulnerabilityError);
      const vuln = e as VulnerabilityError;
      expect(vuln.context["changeType"]).toBe("leaked-reference");
      expect(vuln.context["prototype"]).toBe("Array.prototype");
      expect(vuln.context["keyPath"]).toBe("x");
    }
  });

  it("snapshot-diff takes priority over reference leak", () => {
    detector.setup();
    detector.beforeIteration();
    // Both: mutation AND leaked reference
    (Object.prototype as Record<string, unknown>)["polluted"] = true;
    try {
      detector.afterIteration({ x: Array.prototype });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VulnerabilityError);
      const vuln = e as VulnerabilityError;
      // The snapshot-diff finding should win
      expect(vuln.context["changeType"]).toBe("added");
    }
  });

  it("clean return value produces no finding", () => {
    detector.setup();
    detector.beforeIteration();
    expect(() => detector.afterIteration({ x: 1, y: "hello" })).not.toThrow();
  });

  it("undefined return value produces no finding", () => {
    detector.setup();
    detector.beforeIteration();
    expect(() => detector.afterIteration(undefined)).not.toThrow();
  });

  it("no return value (called without argument) produces no finding", () => {
    detector.setup();
    detector.beforeIteration();
    expect(() => detector.afterIteration()).not.toThrow();
  });
});

// ── resetIteration restore failure ──────────────────────────────────────
//
// These tests plant non-configurable properties on Object.prototype, which
// cannot be removed for the lifetime of this worker. That is safe here:
// vitest isolates test files in separate workers, and within this file
// every later beforeIteration() absorbs the residue into its baseline
// snapshot (restore of an identical descriptor on a non-configurable
// property is a legal no-op). Kept at the end of the file regardless.

describe("PrototypePollutionDetector resetIteration restore failure", () => {
  function spyStderr() {
    return vi.spyOn(process.stderr, "write").mockReturnValue(true);
  }

  function output(spy: ReturnType<typeof spyStderr>): string {
    return spy.mock.calls.map((c) => String(c[0])).join("");
  }

  afterEach(() => {
    vi.restoreAllMocks();
    // Safety net: if a restore assertion fails, don't leak enumerable
    // pollution into later tests. The non-configurable keys are permanent
    // by design (see the comment above this describe).
    delete (Object.prototype as Record<string, unknown>)["__vitiate_test_ok"];
    delete (Array.prototype as unknown as Record<string, unknown>)[
      "__vitiate_test_arr"
    ];
  });

  it("non-configurable added property does not throw and warns with residue", () => {
    const detector = new PrototypePollutionDetector();
    detector.setup();
    detector.beforeIteration();

    Object.defineProperty(Object.prototype, "__vitiate_test_nc1", {
      value: 1,
      configurable: false,
    });

    const spy = spyStderr();
    expect(() => detector.resetIteration()).not.toThrow();

    expect(output(spy)).toContain("__vitiate_test_nc1");
    expect(output(spy)).toContain("unreliable");
    // Residue: the property cannot be removed and is still present.
    expect(
      Object.getOwnPropertyDescriptor(Object.prototype, "__vitiate_test_nc1"),
    ).toBeDefined();
  });

  it("restore continues past a failing property", () => {
    const detector = new PrototypePollutionDetector();
    detector.setup();
    detector.beforeIteration();

    Object.defineProperty(Object.prototype, "__vitiate_test_nc2", {
      value: 1,
      configurable: false,
    });
    (Object.prototype as Record<string, unknown>)["__vitiate_test_ok"] = 1;
    (Array.prototype as unknown as Record<string, unknown>)[
      "__vitiate_test_arr"
    ] = 1;

    const spy = spyStderr();
    expect(() => detector.resetIteration()).not.toThrow();

    // Restorable pollution is removed despite the failing key.
    expect(
      Object.prototype.hasOwnProperty.call(
        Object.prototype,
        "__vitiate_test_ok",
      ),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        Array.prototype,
        "__vitiate_test_arr",
      ),
    ).toBe(false);
    // Warning only for the non-restorable key.
    expect(output(spy)).toContain("__vitiate_test_nc2");
    expect(output(spy)).not.toContain("__vitiate_test_ok");
    expect(output(spy)).not.toContain("__vitiate_test_arr");
  });

  it("snapshotted property redefined non-configurable warns instead of throwing", () => {
    // Snapshotted as configurable...
    Object.defineProperty(Object.prototype, "__vitiate_test_flip", {
      value: 1,
      writable: true,
      configurable: true,
      enumerable: false,
    });

    const detector = new PrototypePollutionDetector();
    detector.setup();
    detector.beforeIteration();

    // ...then the "target" flips it non-configurable, so restore's
    // defineProperty (configurable back to true) throws TypeError.
    Object.defineProperty(Object.prototype, "__vitiate_test_flip", {
      value: 2,
      configurable: false,
    });

    const spy = spyStderr();
    expect(() => detector.resetIteration()).not.toThrow();
    expect(output(spy)).toContain("__vitiate_test_flip");
    expect(output(spy)).toContain("unreliable");
  });

  it("dedupes the residue warning per key across repeated resets", () => {
    const detector = new PrototypePollutionDetector();
    detector.setup();
    detector.beforeIteration();

    Object.defineProperty(Object.prototype, "__vitiate_test_nc4", {
      value: 1,
      configurable: false,
    });

    const spy = spyStderr();
    detector.resetIteration();
    detector.resetIteration();

    const mentions = spy.mock.calls.filter((c) =>
      String(c[0]).includes("__vitiate_test_nc4"),
    );
    expect(mentions).toHaveLength(1);
  });
});
