import { describe, it, expect, afterEach } from "vitest";
import { VulnerabilityError } from "./types.js";
import {
  setDetectorActive,
  drainStashedVulnerabilityError,
} from "./module-hook.js";
import { RedosDetector } from "./redos.js";

describe("RedosDetector", () => {
  let detector: RedosDetector;

  afterEach(() => {
    detector?.teardown();
    setDetectorActive(false);
    drainStashedVulnerabilityError();
  });

  it("has name 'redos' and tier 2", () => {
    detector = new RedosDetector();
    expect(detector.name).toBe("redos");
    expect(detector.tier).toBe(2);
  });

  it("returns backtracking payload tokens", () => {
    detector = new RedosDetector();
    const tokens = detector.getTokens();
    expect(tokens.length).toBe(4);
    const decoded = tokens.map((t) => new TextDecoder().decode(t));
    expect(decoded).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaa!");
  });

  it("does not fire for fast regex", () => {
    detector = new RedosDetector(100);
    detector.setup();
    setDetectorActive(true);
    // Simple regex should complete instantly
    const result = /hello/.exec("hello world");
    expect(result).not.toBeNull();
  });

  it("is inactive outside iteration window", () => {
    detector = new RedosDetector(0); // threshold of 0ms - would fire on any regex
    detector.setup();
    // Do NOT set detectorActive
    // This should pass through without firing
    expect(/test/.test("test")).toBe(true);
  });

  it("string argument to String.prototype.match skips the match wrapper timing", () => {
    detector = new RedosDetector(100);
    detector.setup();
    setDetectorActive(true);
    // String arg (not RegExp) should pass through the match wrapper without timing
    // Note: V8 may still call RegExp.prototype.exec internally, which is a separate wrapper
    expect("hello".match("hello")).not.toBeNull();
  });

  it("undefined argument to String.prototype.match skips the match wrapper timing", () => {
    detector = new RedosDetector(100);
    detector.setup();
    setDetectorActive(true);
    // undefined arg should pass through the match wrapper
    expect("hello".match(undefined as unknown as string)).not.toBeNull();
  });

  it("replaceAll with non-global regex propagates TypeError", () => {
    detector = new RedosDetector(100);
    detector.setup();
    setDetectorActive(true);
    expect(() => "hello".replaceAll(/h/, "x")).toThrow(TypeError);
  });

  it("wraps String.prototype.matchAll", () => {
    const origMatchAll = String.prototype.matchAll;
    detector = new RedosDetector();
    detector.setup();
    expect(String.prototype.matchAll).not.toBe(origMatchAll);
    // Verify it works: matchAll with a simple regex should succeed
    setDetectorActive(true);
    const results = [..."hello hello".matchAll(/hello/g)];
    expect(results.length).toBe(2);
  });

  it("restores prototype methods on teardown", () => {
    const origExec = RegExp.prototype.exec;
    const origTest = RegExp.prototype.test;
    const origMatch = String.prototype.match;
    const origMatchAll = String.prototype.matchAll;
    detector = new RedosDetector();
    detector.setup();
    // After setup, methods should be wrapped
    expect(RegExp.prototype.exec).not.toBe(origExec);
    detector.teardown();
    // After teardown, methods should be restored
    expect(RegExp.prototype.exec).toBe(origExec);
    expect(RegExp.prototype.test).toBe(origTest);
    expect(String.prototype.match).toBe(origMatch);
    expect(String.prototype.matchAll).toBe(origMatchAll);
  });

  it("stash recovery when target catches VulnerabilityError", () => {
    detector = new RedosDetector(0); // threshold 0ms - fires on any timed regex call
    detector.setup();
    setDetectorActive(true);

    // Simulate target catching the error
    try {
      /test/.exec("test");
    } catch {
      // Target swallows the error
    }

    // The stashed error should be recoverable
    const stashed = drainStashedVulnerabilityError();
    expect(stashed).toBeInstanceOf(VulnerabilityError);
    expect(stashed?.vulnerabilityType).toBe("ReDoS");
  });

  it("long input is truncated in context", () => {
    detector = new RedosDetector(0); // threshold 0 - fires on any timed call
    detector.setup();
    setDetectorActive(true);

    const longInput = "a".repeat(2000);
    try {
      /test/.exec(longInput);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VulnerabilityError);
      const ve = e as VulnerabilityError;
      expect((ve.context["input"] as string).length).toBe(1024);
    }
  });

  it("detects genuinely vulnerable regex pattern", () => {
    detector = new RedosDetector(5); // 5ms threshold
    detector.setup();
    setDetectorActive(true);

    // (a+)+b is a classic exponential backtracking pattern.
    // "a".repeat(22) + "!" causes backtracking well beyond 5ms but completes
    // within vitest's default timeout.
    expect(() => {
      /(a+)+b/.exec("a".repeat(22) + "!");
    }).toThrow(VulnerabilityError);
  });

  it("does not fire false positive for non-vulnerable regex at same threshold", () => {
    detector = new RedosDetector(5); // Same 5ms threshold
    detector.setup();
    setDetectorActive(true);

    // Simple linear-time regex should not trigger
    const result = /^[a-z]+$/.exec("a".repeat(1000));
    expect(result).not.toBeNull();
  });

  it("no-op lifecycle hooks do not throw", () => {
    detector = new RedosDetector();
    detector.beforeIteration();
    detector.afterIteration();
    detector.resetIteration();
  });
});
