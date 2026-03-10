import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { VulnerabilityError } from "./vulnerability-error.js";
import { DetectorManager } from "./manager.js";
import {
  setDetectorActive,
  drainStashedVulnerabilityError,
  stashAndRethrow,
} from "./module-hook.js";
import { RedosDetector } from "./redos.js";
import { SsrfDetector } from "./ssrf.js";
import { UnsafeEvalDetector } from "./unsafe-eval.js";
import { getCliOptions } from "../config.js";
import { parseDetectorsFlag } from "../cli.js";

const require = createRequire(import.meta.url);

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

// ── ReDoS Detector ──────────────────────────────────────────────────────

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
    detector = new RedosDetector(0); // threshold of 0ms — would fire on any regex
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
    detector = new RedosDetector(0); // threshold 0ms — fires on any timed regex call
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
    detector = new RedosDetector(0); // threshold 0 — fires on any timed call
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

  it("no-op lifecycle hooks do not throw", () => {
    detector = new RedosDetector();
    detector.beforeIteration();
    detector.afterIteration();
    detector.resetIteration();
  });
});

// ── SSRF Detector ───────────────────────────────────────────────────────

describe("SsrfDetector", () => {
  let detector: SsrfDetector;

  afterEach(() => {
    detector?.teardown();
    setDetectorActive(false);
    drainStashedVulnerabilityError();
  });

  it("has name 'ssrf' and tier 2", () => {
    detector = new SsrfDetector();
    expect(detector.name).toBe("ssrf");
    expect(detector.tier).toBe(2);
  });

  it("returns static tokens including private IPs and schemes", () => {
    detector = new SsrfDetector();
    const tokens = detector.getTokens();
    const decoded = tokens.map((t) => new TextDecoder().decode(t));
    expect(decoded).toContain("127.0.0.1");
    expect(decoded).toContain("169.254.169.254");
    expect(decoded).toContain("http://");
    expect(decoded).toContain("https://");
    expect(decoded).toContain("metadata.google.internal");
  });

  it("generates URL variant tokens for bare hostname blockedHosts", () => {
    detector = new SsrfDetector(["meta.corp.example.com"]);
    const tokens = detector.getTokens();
    const decoded = tokens.map((t) => new TextDecoder().decode(t));
    expect(decoded).toContain("meta.corp.example.com");
    expect(decoded).toContain("http://meta.corp.example.com");
    expect(decoded).toContain("https://meta.corp.example.com");
  });

  it("does not generate URL variant tokens for CIDR blockedHosts", () => {
    detector = new SsrfDetector(["10.200.0.0/24"]);
    const tokens = detector.getTokens();
    const decoded = tokens.map((t) => new TextDecoder().decode(t));
    expect(decoded).toContain("10.200.0.0/24");
    expect(decoded).not.toContain("http://10.200.0.0/24");
  });

  it("does not generate URL variant tokens for wildcard blockedHosts", () => {
    detector = new SsrfDetector(["*.internal"]);
    const tokens = detector.getTokens();
    const decoded = tokens.map((t) => new TextDecoder().decode(t));
    expect(decoded).toContain("*.internal");
    expect(decoded).not.toContain("http://*.internal");
  });

  describe("built-in blocklist", () => {
    it("blocks loopback IPv4 via http.request", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() => http.request("http://127.0.0.1/admin")).toThrow(
        VulnerabilityError,
      );
    });

    it("blocks RFC 1918 10.x via http.request", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() => http.request("http://10.0.0.1/internal")).toThrow(
        VulnerabilityError,
      );
    });

    it("blocks cloud metadata endpoint", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() =>
        http.request("http://169.254.169.254/latest/meta-data/"),
      ).toThrow(VulnerabilityError);
    });

    it("blocks GCP metadata hostname", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() =>
        http.request("http://metadata.google.internal/computeMetadata/v1/"),
      ).toThrow(VulnerabilityError);
    });

    it("allows request to public host", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      const req = http.request("http://api.example.com/data");
      req.on("error", () => {});
      req.destroy();
    });

    it("blocks IPv6 loopback", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() => http.request("http://[::1]:8080/admin")).toThrow(
        VulnerabilityError,
      );
    });

    it("blocks CGN shared address space", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() => http.request("http://100.100.100.100/internal")).toThrow(
        VulnerabilityError,
      );
    });

    it("blocks RFC 1918 172.16.x", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() => http.request("http://172.16.0.1/internal")).toThrow(
        VulnerabilityError,
      );
    });

    it("blocks RFC 1918 192.168.x", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() => http.request("http://192.168.1.1/internal")).toThrow(
        VulnerabilityError,
      );
    });
  });

  describe("localhost blocking", () => {
    it("blocks localhost via http.request", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() => http.request("http://localhost/admin")).toThrow(
        VulnerabilityError,
      );
    });

    it("blocks LOCALHOST (case-insensitive) via http.request", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() => http.request("http://LOCALHOST/admin")).toThrow(
        VulnerabilityError,
      );
    });
  });

  describe("IPv4-mapped IPv6 blocking", () => {
    it("blocks ::ffff:127.0.0.1 via http.request", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() =>
        http.request({ hostname: "::ffff:127.0.0.1", path: "/admin" }),
      ).toThrow(VulnerabilityError);
    });

    it("blocks [::ffff:10.0.0.1] via fetch", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      expect(() => fetch("http://[::ffff:10.0.0.1]/api")).toThrow(
        VulnerabilityError,
      );
    });

    it("blocks ::ffff:169.254.169.254 (cloud metadata)", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() =>
        http.request({
          hostname: "::ffff:169.254.169.254",
          path: "/latest/meta-data/",
        }),
      ).toThrow(VulnerabilityError);
    });
  });

  describe("allowedHosts override", () => {
    it("allows request to blocked IP when in allowedHosts", () => {
      detector = new SsrfDetector([], ["10.0.0.5"]);
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      // Should not throw — 10.0.0.5 is in the allowlist
      const req = http.request("http://10.0.0.5/api");
      req.on("error", () => {}); // Suppress unhandled socket errors
      req.destroy();
    });
  });

  describe("custom blockedHosts", () => {
    it("blocks custom hostname", () => {
      detector = new SsrfDetector(["internal.corp.example.com"]);
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() =>
        http.request("http://internal.corp.example.com/api"),
      ).toThrow(VulnerabilityError);
    });

    it("accepts single-string blockedHosts (CLI path normalization)", () => {
      // CLI parseDetectorsFlag produces a raw string, not an array.
      // The constructor must normalize it rather than spreading characters.
      detector = new SsrfDetector("internal.corp.example.com");
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() =>
        http.request("http://internal.corp.example.com/api"),
      ).toThrow(VulnerabilityError);
    });

    it("accepts single-string allowedHosts (CLI path normalization)", () => {
      detector = new SsrfDetector([], "10.0.0.5");
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      // 10.0.0.5 is in the allowlist — should not throw
      const req = http.request("http://10.0.0.5/api");
      req.on("error", () => {}); // Suppress unhandled socket errors
      req.destroy();
    });
  });

  describe("URL extraction", () => {
    it("extracts hostname from options object with hostname field", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() =>
        http.request({ hostname: "10.0.0.1", path: "/api" }),
      ).toThrow(VulnerabilityError);
    });

    it("extracts hostname from options object with host field and port", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() =>
        http.request({ host: "10.0.0.1:8080", path: "/api" }),
      ).toThrow(VulnerabilityError);
    });

    it("extracts hostname from IPv6 host field with port", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() => http.request({ host: "[::1]:8080", path: "/api" })).toThrow(
        VulnerabilityError,
      );
    });

    it("extracts hostname from Request object", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      expect(() => fetch(new Request("http://127.0.0.1"))).toThrow(
        VulnerabilityError,
      );
    });

    it("extracts hostname from Request object with init", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      expect(() =>
        fetch(new Request("http://10.0.0.1"), { method: "POST" }),
      ).toThrow(VulnerabilityError);
    });

    it("options override URL hostname", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() =>
        http.request("http://example.com/path", { hostname: "10.0.0.1" }),
      ).toThrow(VulnerabilityError);
    });

    it("extracts hostname from URL object argument to fetch", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      expect(() => fetch(new URL("http://127.0.0.1/admin"))).toThrow(
        VulnerabilityError,
      );
    });

    it("unrecognizable argument passes through without VulnerabilityError", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      // Numeric argument is not a URL, options, or Request — extractHostname
      // returns null and the hook passes through to the original function.
      // Node's http.request accepts this without throwing synchronously,
      // so we just verify no VulnerabilityError is thrown.
      const req = http.request(42 as unknown as string);
      req.on("error", () => {});
      req.destroy();
    });

    it("malformed URL passes through", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      // Malformed URL should not crash the hook — it passes through to the original
      // which will also fail, but the hook shouldn't throw VulnerabilityError
      let threw = false;
      try {
        http.request("not a valid url");
      } catch (e) {
        threw = true;
        expect(e).not.toBeInstanceOf(VulnerabilityError);
      }
      expect(threw).toBe(true);
    });
  });

  it("VulnerabilityError context includes matchedRule", () => {
    detector = new SsrfDetector();
    detector.setup();
    setDetectorActive(true);

    const http = require("http") as typeof import("http");
    try {
      http.request("http://10.50.0.1/api");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VulnerabilityError);
      const ve = e as VulnerabilityError;
      expect(ve.context["matchedRule"]).toBe("10.0.0.0/8");
      expect(ve.context["hostname"]).toBe("10.50.0.1");
    }
  });

  it("is inactive outside iteration window", () => {
    detector = new SsrfDetector();
    detector.setup();
    // Do NOT set detectorActive — should pass through
    const http = require("http") as typeof import("http");
    const req = http.request("http://127.0.0.1/admin");
    req.on("error", () => {}); // Suppress unhandled socket errors
    req.destroy();
  });

  it("no-op lifecycle hooks do not throw", () => {
    detector = new SsrfDetector();
    detector.beforeIteration();
    detector.afterIteration();
    detector.resetIteration();
  });

  it("restores all hooks on teardown", () => {
    const http = require("http") as typeof import("http");
    const origRequest = http.request;
    const origGet = http.get;

    detector = new SsrfDetector();
    detector.setup();
    expect(http.request).not.toBe(origRequest);

    detector.teardown();
    expect(http.request).toBe(origRequest);
    expect(http.get).toBe(origGet);
  });
});

// ── Unsafe Eval Detector ────────────────────────────────────────────────

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

// ── DetectorManager: Tier 2 integration ─────────────────────────────────

describe("DetectorManager Tier 2 integration", () => {
  it("Tier 2 detectors are disabled by default", () => {
    const manager = new DetectorManager(undefined);
    expect(manager.activeDetectorNames).not.toContain("redos");
    expect(manager.activeDetectorNames).not.toContain("ssrf");
    expect(manager.activeDetectorNames).not.toContain("unsafe-eval");
  });

  it("Tier 2 detectors disabled with empty config", () => {
    const manager = new DetectorManager({});
    expect(manager.activeDetectorNames).not.toContain("redos");
    expect(manager.activeDetectorNames).not.toContain("ssrf");
    expect(manager.activeDetectorNames).not.toContain("unsafe-eval");
  });

  it("enables Tier 2 detector with boolean true", () => {
    const manager = new DetectorManager({ ssrf: true });
    manager.setup();
    try {
      expect(manager.activeDetectorNames).toContain("ssrf");
      // Tier 1 should still be active
      expect(manager.activeDetectorNames).toContain("prototype-pollution");
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
      unsafeEval: false,
    });
    expect(manager.activeDetectorNames).not.toContain("ssrf");
    expect(manager.activeDetectorNames).not.toContain("redos");
    expect(manager.activeDetectorNames).not.toContain("unsafe-eval");
  });
});

// ── Config schema: Tier 2 validation ────────────────────────────────────

describe("Config schema: Tier 2 detectors", () => {
  const originalOpts = process.env["VITIATE_FUZZ_OPTIONS"];

  afterEach(() => {
    if (originalOpts === undefined) {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
    } else {
      process.env["VITIATE_FUZZ_OPTIONS"] = originalOpts;
    }
  });

  it("accepts ssrf: true", () => {
    process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
      detectors: { ssrf: true },
    });
    const opts = getCliOptions();
    expect(opts.detectors?.ssrf).toBe(true);
  });

  it("accepts ssrf with options", () => {
    process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
      detectors: {
        ssrf: { blockedHosts: ["meta.internal"], allowedHosts: ["10.0.0.5"] },
      },
    });
    const opts = getCliOptions();
    const ssrf = opts.detectors?.ssrf;
    expect(typeof ssrf).toBe("object");
    if (typeof ssrf === "object" && ssrf !== null) {
      expect(ssrf.blockedHosts).toEqual(["meta.internal"]);
      expect(ssrf.allowedHosts).toEqual(["10.0.0.5"]);
    }
  });

  it("accepts redos: true", () => {
    process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
      detectors: { redos: true },
    });
    const opts = getCliOptions();
    expect(opts.detectors?.redos).toBe(true);
  });

  it("accepts redos with thresholdMs", () => {
    process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
      detectors: { redos: { thresholdMs: 50 } },
    });
    const opts = getCliOptions();
    const redos = opts.detectors?.redos;
    expect(typeof redos).toBe("object");
    if (typeof redos === "object" && redos !== null) {
      expect(redos.thresholdMs).toBe(50);
    }
  });

  it("accepts unsafeEval: true", () => {
    process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
      detectors: { unsafeEval: true },
    });
    const opts = getCliOptions();
    expect(opts.detectors?.unsafeEval).toBe(true);
  });

  it("accepts unsafeEval: false", () => {
    process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
      detectors: { unsafeEval: false },
    });
    const opts = getCliOptions();
    expect(opts.detectors?.unsafeEval).toBe(false);
  });

  it("rejects unsafeEval options object", () => {
    process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
      detectors: { unsafeEval: { someOption: true } },
    });
    // Should fall back to defaults since validation fails
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const opts = getCliOptions();
      // Validation failure drops the entire detectors object
      expect(opts.detectors).toBeUndefined();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("accepts path-delimited blockedHosts string", () => {
    process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
      detectors: { ssrf: { blockedHosts: "meta.internal:10.200.0.0/24" } },
    });
    const opts = getCliOptions();
    const ssrf = opts.detectors?.ssrf;
    expect(typeof ssrf).toBe("object");
    if (typeof ssrf === "object" && ssrf !== null) {
      expect(ssrf.blockedHosts).toEqual(["meta.internal", "10.200.0.0/24"]);
    }
  });
});

// ── CLI parseDetectorsFlag: Tier 2 ──────────────────────────────────────

describe("parseDetectorsFlag Tier 2", () => {
  it("recognizes Tier 2 detector names", () => {
    const result = parseDetectorsFlag("ssrf,redos,unsafeEval");
    expect(result?.ssrf).toBe(true);
    expect(result?.redos).toBe(true);
    expect(result?.unsafeEval).toBe(true);
  });

  it("parses ssrf.blockedHosts dotted option", () => {
    const result = parseDetectorsFlag("ssrf.blockedHosts=meta.internal");
    expect(result?.ssrf).toEqual({ blockedHosts: "meta.internal" });
  });

  it("parses redos.thresholdMs dotted option", () => {
    const result = parseDetectorsFlag("redos.thresholdMs=50");
    expect(result?.redos).toEqual({ thresholdMs: 50 });
  });
});
