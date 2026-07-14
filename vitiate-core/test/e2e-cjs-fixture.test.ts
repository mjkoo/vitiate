/**
 * E2E tests for CommonJS-dependency instrumentation scenarios that the real npm
 * targets (node-forge/jpeg-js) do not cover: detector hooks reaching a bundled
 * dependency's hooked-builtin call, crash stack traces mapping back through the
 * source map, and named-export binding. Driven by vitest.cjs-fixture.config.ts,
 * which writes the multi-file `vitiate-cjs-fixture` package into node_modules.
 */
import { describe, it, expect } from "vitest";
import fixture from "vitiate-cjs-fixture";
import { VulnerabilityError } from "../src/detectors/index.js";
import { CommandInjectionDetector } from "../src/detectors/command-injection.js";
import { setDetectorActive } from "../src/detectors/module-hook.js";

describe("e2e: CommonJS fixture instrumentation", () => {
  it("detector intercepts a hooked builtin called from inside a bundled CJS dependency", () => {
    // The fixture's exec.js calls child_process.execSync through the bundle's
    // createRequire bridge. Because that native require returns the same CJS
    // module object detector hooks are installed on, an armed command-injection
    // detector intercepts the call - no import rewriting needed (Decision 8).
    const detector = new CommandInjectionDetector();
    detector.setup();
    setDetectorActive(true);
    try {
      expect(() => fixture.runCommand("echo vitiate_cmd_inject")).toThrow(
        VulnerabilityError,
      );
    } finally {
      setDetectorActive(false);
      detector.teardown();
    }
  });

  it("maps a crash inside a bundled CJS dependency back through the source map", () => {
    const cov = globalThis.__vitiate_cov;
    const before = new Uint8Array(cov);

    let err: Error | undefined;
    try {
      fixture.crash("BOOM");
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeDefined();
    expect(err?.message).toContain("cjs fixture crash");
    // The stack must reference the ORIGINAL source file (crash.js), proving the
    // esbuild source map is applied to the bundled dependency's stack trace.
    expect(err?.stack).toContain("crash.js");

    // Driving the crash path also exercised instrumented fixture code.
    let edges = 0;
    for (let i = 0; i < cov.length; i++) if (cov[i] !== before[i]) edges++;
    expect(edges).toBeGreaterThan(0);
  });

  it("binds a named export from the bundled CJS fixture", () => {
    // Node's CJS-ESM interop would expose `named`; the synthetic entry re-exports
    // it, so the default-object property is present after bundling.
    expect(fixture.named).toBe(123);
  });
});
