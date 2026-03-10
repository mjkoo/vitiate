import { describe, it, expect, afterEach } from "vitest";
import { VulnerabilityError } from "./types.js";
import { setDetectorActive } from "./module-hook.js";
import { CommandInjectionDetector } from "./command-injection.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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

  it("resetIteration is a no-op", () => {
    detector = new CommandInjectionDetector();
    // Should not throw
    detector.resetIteration();
  });
});
