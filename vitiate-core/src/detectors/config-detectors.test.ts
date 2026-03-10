import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { getCliOptions } from "../config.js";
import { parseDetectorsFlag } from "../cli.js";

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
    const delimiter = path.delimiter; // ":" on POSIX, ";" on Windows
    process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify({
      detectors: {
        ssrf: {
          blockedHosts: `meta.internal${delimiter}10.200.0.0/24`,
        },
      },
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
