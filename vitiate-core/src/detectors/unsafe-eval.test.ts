import { describe, it, expect, afterEach } from "vitest";
import { VulnerabilityError } from "./types.js";
import {
  setDetectorActive,
  drainStashedVulnerabilityError,
} from "./module-hook.js";
import { UnsafeEvalDetector } from "./unsafe-eval.js";

describe("UnsafeEvalDetector", () => {
  let detector: UnsafeEvalDetector;

  afterEach(() => {
    detector?.teardown();
    setDetectorActive(false);
    drainStashedVulnerabilityError();
  });

  it("has name 'unsafe-eval' and tier 2", () => {
    detector = new UnsafeEvalDetector();
    expect(detector.name).toBe("unsafe-eval");
    expect(detector.tier).toBe(2);
  });

  it("returns goal string and metacharacter tokens", () => {
    detector = new UnsafeEvalDetector();
    const tokens = detector.getTokens();
    const decoded = tokens.map((t) => new TextDecoder().decode(t));
    expect(decoded).toContain("vitiate_eval_inject");
    expect(decoded).toContain('require("');
    expect(decoded).toContain("process.exit");
    expect(decoded).toContain("import(");
  });

  it("detects goal string in eval argument", () => {
    detector = new UnsafeEvalDetector();
    detector.setup();
    setDetectorActive(true);

    expect(() => eval("'vitiate_eval_inject'")).toThrow(VulnerabilityError);
  });

  it("passes through eval without goal string", () => {
    detector = new UnsafeEvalDetector();
    detector.setup();
    setDetectorActive(true);

    expect(eval("1 + 1")).toBe(2);
  });

  it("passes through non-string eval argument", () => {
    detector = new UnsafeEvalDetector();
    detector.setup();
    setDetectorActive(true);

    // eval(42) returns 42 (non-string args pass through)
    expect(eval("42")).toBe(42);
  });

  it("detects goal string in Function constructor body", () => {
    detector = new UnsafeEvalDetector();
    detector.setup();
    setDetectorActive(true);

    expect(() => new Function("return 'vitiate_eval_inject'")).toThrow(
      VulnerabilityError,
    );
  });

  it("detects goal string in Function constructor params", () => {
    detector = new UnsafeEvalDetector();
    detector.setup();
    setDetectorActive(true);

    expect(() => new Function("vitiate_eval_inject", "return 1")).toThrow(
      VulnerabilityError,
    );
  });

  it("detects goal string when Function called without new", () => {
    detector = new UnsafeEvalDetector();
    detector.setup();
    setDetectorActive(true);

    expect(() => Function("return 'vitiate_eval_inject'")).toThrow(
      VulnerabilityError,
    );
  });

  it("passes through Function without goal string", () => {
    detector = new UnsafeEvalDetector();
    detector.setup();
    setDetectorActive(true);

    const fn = new Function("a", "b", "return a + b");
    expect(fn(1, 2)).toBe(3);
  });

  it("is inactive outside iteration window", () => {
    detector = new UnsafeEvalDetector();
    detector.setup();
    // Do NOT set detectorActive
    expect(eval("'vitiate_eval_inject'")).toBe("vitiate_eval_inject");
  });

  it("restores originals on teardown", () => {
    const origEval = globalThis.eval;
    const origFunction = globalThis.Function;

    detector = new UnsafeEvalDetector();
    detector.setup();
    expect(globalThis.eval).not.toBe(origEval);

    detector.teardown();
    expect(globalThis.eval).toBe(origEval);
    expect(globalThis.Function).toBe(origFunction);
  });

  it("no-op lifecycle hooks do not throw", () => {
    detector = new UnsafeEvalDetector();
    detector.beforeIteration();
    detector.afterIteration();
    detector.resetIteration();
  });

  it("stash recovery when target catches VulnerabilityError", () => {
    detector = new UnsafeEvalDetector();
    detector.setup();
    setDetectorActive(true);

    // Simulate target catching the error
    try {
      eval("'vitiate_eval_inject'");
    } catch {
      // Target swallows the error
    }

    const stashed = drainStashedVulnerabilityError();
    expect(stashed).toBeInstanceOf(VulnerabilityError);
    expect(stashed?.vulnerabilityType).toBe("Unsafe Eval");
  });
});
