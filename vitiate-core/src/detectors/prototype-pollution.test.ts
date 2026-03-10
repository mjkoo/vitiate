import { describe, it, expect, afterEach } from "vitest";
import { VulnerabilityError } from "./types.js";
import { PrototypePollutionDetector } from "./prototype-pollution.js";

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
