import nodePath from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { VulnerabilityError } from "./types.js";
import { installHook, setDetectorActive } from "./module-hook.js";
import { PathTraversalDetector } from "./path-traversal.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** A path that is in the default deniedPaths on the current platform. */
const PLATFORM_DENIED_PATH =
  process.platform === "win32"
    ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
    : "/etc/passwd";

describe("PathTraversalDetector", () => {
  let detector: PathTraversalDetector;

  afterEach(() => {
    detector?.teardown();
    setDetectorActive(false);
  });

  // ── Policy model tests ──

  it("default policy denies platform-specific sensitive path", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync(PLATFORM_DENIED_PATH)).toThrow(
      VulnerabilityError,
    );
  });

  it("default policy allows arbitrary paths outside deniedPaths", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    const fn = () => {
      try {
        fs.readFileSync("/tmp/data.txt");
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fn).not.toThrow();
  });

  it("custom allowedPaths restricts access", () => {
    detector = new PathTraversalDetector(["/var/www"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("/etc/hosts")).toThrow(VulnerabilityError);
  });

  it("custom allowedPaths permits subtree", () => {
    detector = new PathTraversalDetector(["/var/www"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    const fn = () => {
      try {
        fs.readFileSync("/var/www/index.html");
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fn).not.toThrow();
  });

  it("deniedPaths overrides allowedPaths", () => {
    detector = new PathTraversalDetector(["/tmp"], ["/tmp/secrets"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("/tmp/secrets/key.pem")).toThrow(
      VulnerabilityError,
    );
  });

  it("accepts single-string deniedPaths (CLI path normalization)", () => {
    // CLI parseDetectorsFlag produces a raw string, not an array.
    // The constructor must normalize it rather than calling .map() on a string.
    detector = new PathTraversalDetector(undefined, "/tmp/secrets");
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("/tmp/secrets/key.pem")).toThrow(
      VulnerabilityError,
    );
  });

  it("accepts single-string allowedPaths (CLI path normalization)", () => {
    detector = new PathTraversalDetector("/var/www");
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("/etc/hosts")).toThrow(VulnerabilityError);
  });

  it("separator-aware prefix matching prevents false positives", () => {
    detector = new PathTraversalDetector(["/var/www"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    // /var/www-evil is NOT inside /var/www
    expect(() => fs.readFileSync("/var/www-evil/data.txt")).toThrow(
      VulnerabilityError,
    );
  });

  it("deniedPaths uses separator-aware prefix matching", () => {
    detector = new PathTraversalDetector(["/"], ["/etc/passwd"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    // /etc/passwdx should NOT match denied entry /etc/passwd
    const fn = () => {
      try {
        fs.readFileSync("/etc/passwdx");
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fn).not.toThrow();
  });

  it("detects null byte in path", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    expect(() => fs.readFileSync("safe.txt\x00../../etc/passwd")).toThrow(
      VulnerabilityError,
    );
  });

  it("null byte error context does not include sandboxRoot", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    try {
      fs.readFileSync("safe.txt\x00../../etc/passwd");
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(VulnerabilityError);
      const ve = e as VulnerabilityError;
      expect(ve.context).not.toHaveProperty("sandboxRoot");
      expect(ve.context).toHaveProperty("nullByte", true);
    }
  });

  it("checks both paths in dual-path functions", () => {
    detector = new PathTraversalDetector(["/"], ["/etc/crontab"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    // Destination is denied
    expect(() => fs.copyFileSync("safe.txt", "/etc/crontab")).toThrow(
      VulnerabilityError,
    );
  });

  it("error context includes function name, path, resolved path, and matched entry", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    try {
      fs.readFileSync(PLATFORM_DENIED_PATH);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(VulnerabilityError);
      const ve = e as VulnerabilityError;
      expect(ve.context).toHaveProperty("function", "readFileSync");
      expect(ve.context).toHaveProperty("path", PLATFORM_DENIED_PATH);
      expect(ve.context).toHaveProperty("resolvedPath");
      expect(ve.context).toHaveProperty("deniedEntry");
      expect(ve.context).not.toHaveProperty("sandboxRoot");
    }
  });

  // ── fs/promises hook tests ──

  it("fs/promises async readFile denied path throws VulnerabilityError", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fsPromises = require("fs/promises");
    expect(() => fsPromises.readFile(PLATFORM_DENIED_PATH)).toThrow(
      VulnerabilityError,
    );
  });

  it("fs/promises hooks are independent from fs hooks", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    const fsPromises = require("fs/promises");

    // Both should be hooked
    expect(() => fs.readFileSync(PLATFORM_DENIED_PATH)).toThrow(
      VulnerabilityError,
    );
    expect(() => fsPromises.readFile(PLATFORM_DENIED_PATH)).toThrow(
      VulnerabilityError,
    );

    // Teardown restores both
    detector.teardown();
    setDetectorActive(true);

    // After teardown, neither should throw VulnerabilityError
    const fnFs = () => {
      try {
        fs.readFileSync(PLATFORM_DENIED_PATH);
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fnFs).not.toThrow();
  });

  it("restoring one module hook does not affect the other", () => {
    const check = () => {
      throw new VulnerabilityError("test", "Path Traversal", {});
    };
    const fsHook = installHook("fs", "readFileSync", check);
    const fsPromisesHook = installHook("fs/promises", "readFile", check);

    setDetectorActive(true);

    // Both hooks active
    const fs = require("fs");
    const fsPromises = require("fs/promises");
    expect(() => fs.readFileSync("/etc/passwd")).toThrow(VulnerabilityError);
    expect(() => fsPromises.readFile("/etc/passwd")).toThrow(
      VulnerabilityError,
    );

    // Restore only the fs hook
    fsHook.restore();

    // fs.readFileSync no longer throws VulnerabilityError
    const fnFs = () => {
      try {
        fs.readFileSync("/etc/passwd");
      } catch (e: unknown) {
        if (e instanceof VulnerabilityError) throw e;
      }
    };
    expect(fnFs).not.toThrow();

    // fs/promises.readFile still throws VulnerabilityError
    expect(() => fsPromises.readFile("/etc/passwd")).toThrow(
      VulnerabilityError,
    );

    // Cleanup
    fsPromisesHook.restore();
  });

  it("fs.promises.readFile is intercepted via shared object identity", () => {
    detector = new PathTraversalDetector();
    detector.setup();
    setDetectorActive(true);

    // Node.js guarantees require("fs").promises === require("fs/promises").
    // Hooking fs/promises should also intercept fs.promises.readFile().
    const fs = require("fs");
    expect(() => fs.promises.readFile(PLATFORM_DENIED_PATH)).toThrow(
      VulnerabilityError,
    );
  });

  it("implicit deny context has resolvedPath but not deniedEntry", () => {
    detector = new PathTraversalDetector(["/var/www"]);
    detector.setup();
    setDetectorActive(true);

    const fs = require("fs");
    try {
      fs.readFileSync("/etc/hosts");
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(VulnerabilityError);
      const ve = e as VulnerabilityError;
      expect(ve.context).toHaveProperty("resolvedPath");
      expect(ve.context).toHaveProperty("function", "readFileSync");
      expect(ve.context).toHaveProperty("path", "/etc/hosts");
      expect(ve.context).not.toHaveProperty("deniedEntry");
    }
  });

  // ── Token tests ──

  it("returns static traversal tokens and deniedPaths entries", () => {
    detector = new PathTraversalDetector();
    const tokens = detector.getTokens();
    const tokenStrings = tokens.map((t) => new TextDecoder().decode(t));
    expect(tokenStrings).toContain("../");
    expect(tokenStrings).toContain("../../");
    expect(tokenStrings).toContain("../../../");
    expect(tokenStrings).toContain("..\\");
    expect(tokenStrings).toContain("\x00");
    expect(tokenStrings).toContain("%2e%2e%2f");
    // Default deniedPaths is platform-dependent
    if (process.platform === "win32") {
      expect(tokenStrings).toContain(
        nodePath.resolve("C:\\Windows\\System32\\drivers\\etc\\hosts"),
      );
    } else {
      expect(tokenStrings).toContain("/etc/passwd");
    }
  });

  it("does not include sandbox-path-derived tokens", () => {
    detector = new PathTraversalDetector(["/var/www/uploads"]);
    const tokens = detector.getTokens();
    const tokenStrings = tokens.map((t) => new TextDecoder().decode(t));
    // Should NOT include the allowedPaths entry or depth-computed chain
    expect(tokenStrings).not.toContain("/var/www/uploads");
    expect(tokenStrings).not.toContain("../../../etc/passwd");
  });

  it("custom deniedPaths entries appear in tokens", () => {
    detector = new PathTraversalDetector(undefined, [
      "/etc/passwd",
      "/proc/self/environ",
    ]);
    const tokens = detector.getTokens();
    const tokenStrings = tokens.map((t) => new TextDecoder().decode(t));
    // Tokens contain the resolved paths (platform-dependent)
    expect(tokenStrings).toContain(nodePath.resolve("/etc/passwd"));
    expect(tokenStrings).toContain(nodePath.resolve("/proc/self/environ"));
  });

  it("resetIteration is a no-op", () => {
    detector = new PathTraversalDetector();
    // Should not throw
    detector.resetIteration();
  });
});
