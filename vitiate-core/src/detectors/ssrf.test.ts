import { describe, it, expect, afterEach } from "vitest";
import { VulnerabilityError } from "./types.js";
import {
  setDetectorActive,
  drainStashedVulnerabilityError,
} from "./module-hook.js";
import { SsrfDetector } from "./ssrf.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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

  describe("URL-encoded private IPs", () => {
    it("blocks percent-encoded loopback via http.request", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      // 127.0.0.%31 decodes to 127.0.0.1 - Node's URL parser normalizes the
      // percent-encoding before the SSRF hook extracts the hostname, so this
      // test confirms the bypass doesn't work (rather than testing the hook's
      // own decoding logic).
      expect(() => http.request("http://127.0.0.%31/admin")).toThrow(
        VulnerabilityError,
      );
    });

    it("blocks loopback with custom port", () => {
      detector = new SsrfDetector();
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      expect(() => http.request("http://127.0.0.1:9090/admin")).toThrow(
        VulnerabilityError,
      );
    });
  });

  describe("allowedHosts override", () => {
    it("allows request to blocked IP when in allowedHosts", () => {
      detector = new SsrfDetector([], ["10.0.0.5"]);
      detector.setup();
      setDetectorActive(true);

      const http = require("http") as typeof import("http");
      // Should not throw - 10.0.0.5 is in the allowlist
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
      // 10.0.0.5 is in the allowlist - should not throw
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
      // Numeric argument is not a URL, options, or Request - extractHostname
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
      // Malformed URL should not crash the hook - it passes through to the original
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
    // Do NOT set detectorActive - should pass through
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
