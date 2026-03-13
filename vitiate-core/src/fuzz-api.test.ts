import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fuzz, buildTestNamePatternFromNames } from "./fuzz.js";
import {
  isFuzzingMode,
  getProjectRoot,
  setDataDir,
  resetDataDir,
  resolveVitestCli,
} from "./config.js";
import { hashTestPath } from "./nix-base32.js";

describe("fuzz API", () => {
  it("fuzz is a function", () => {
    expect(typeof fuzz).toBe("function");
  });

  it("fuzz.skip is a function", () => {
    expect(typeof fuzz.skip).toBe("function");
  });

  it("fuzz.only is a function", () => {
    expect(typeof fuzz.only).toBe("function");
  });

  it("fuzz.todo is a function", () => {
    expect(typeof fuzz.todo).toBe("function");
  });
});

// fuzz() calls must be at the describe level (not inside test/it),
// because fuzz() delegates to test() which registers with vitest's runner.

describe("fuzz regression mode - smoke test with no corpus", () => {
  // This registers a test via fuzz() that runs in regression mode.
  // With no corpus, it runs the target once with an empty buffer.
  fuzz("smoke-test-empty-buffer", (data) => {
    expect(data.length).toBe(0);
  });
});

describe("fuzz regression mode - replay corpus files", () => {
  const tmpDir = path.join(
    tmpdir(),
    `vitiate-fuzz-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  beforeAll(() => {
    // Set project root so the relative test file path is predictable
    const projectRoot = getProjectRoot();
    const thisFile = fileURLToPath(import.meta.url);
    const relativeFilePath = path.relative(projectRoot, thisFile);
    const hashDir = hashTestPath(relativeFilePath, "regression-replay");
    const seedDir = path.join(tmpDir, "testdata", hashDir, "seeds");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(path.join(seedDir, "seed-hello"), "hello");
    setDataDir(tmpDir);
  });

  afterAll(() => {
    resetDataDir();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  fuzz("regression-replay", (data) => {
    expect(data.length).toBeGreaterThan(0);
  });
});

describe("fuzz mode activation", () => {
  const originalFuzz = process.env["VITIATE_FUZZ"];

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
  });

  it("all fuzz tests enter fuzz loop when VITIATE_FUZZ=1 (no pattern filtering)", () => {
    process.env["VITIATE_FUZZ"] = "1";
    expect(isFuzzingMode()).toBe(true);
  });

  it("no fuzz tests enter fuzz loop when VITIATE_FUZZ is unset", () => {
    delete process.env["VITIATE_FUZZ"];
    expect(isFuzzingMode()).toBe(false);
  });
});

describe("fuzz regression mode - loads extra corpus dirs", () => {
  const tmpBase = path.join(
    tmpdir(),
    `vitiate-fuzz-extra-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const extraDir = path.join(tmpBase, "extra");
  const originalCliIpc = process.env["VITIATE_CLI_IPC"];

  beforeAll(() => {
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(path.join(extraDir, "seed-extra"), "extra-data");
    process.env["VITIATE_CLI_IPC"] = JSON.stringify({ corpusDirs: [extraDir] });
  });

  afterAll(() => {
    if (originalCliIpc === undefined) {
      delete process.env["VITIATE_CLI_IPC"];
    } else {
      process.env["VITIATE_CLI_IPC"] = originalCliIpc;
    }
    rmSync(tmpBase, { recursive: true, force: true });
  });

  const seen: string[] = [];
  fuzz("extra-corpus-regression", (data) => {
    seen.push(data.toString());
  });

  it("replayed at least the extra corpus entry", () => {
    expect(seen).toContain("extra-data");
  });
});

// fuzz.skip and fuzz.todo must also be at the describe level
describe("fuzz modifiers", () => {
  fuzz.skip("this-is-skipped", (_data) => {
    throw new Error("should not run");
  });

  fuzz.todo("this-is-a-todo");
});

describe("supervisor mode detection", () => {
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalSupervisor = process.env["VITIATE_SUPERVISOR"];

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    if (originalSupervisor === undefined) {
      delete process.env["VITIATE_SUPERVISOR"];
    } else {
      process.env["VITIATE_SUPERVISOR"] = originalSupervisor;
    }
  });

  it("isFuzzingMode is true when VITIATE_FUZZ=1 (regardless of VITIATE_SUPERVISOR)", () => {
    process.env["VITIATE_FUZZ"] = "1";
    delete process.env["VITIATE_SUPERVISOR"];
    expect(isFuzzingMode()).toBe(true);

    process.env["VITIATE_SUPERVISOR"] = "1";
    expect(isFuzzingMode()).toBe(true);
  });

  it("parent mode condition: VITIATE_FUZZ=1 and VITIATE_SUPERVISOR not set", () => {
    process.env["VITIATE_FUZZ"] = "1";
    delete process.env["VITIATE_SUPERVISOR"];

    // isFuzzingMode returns true, VITIATE_SUPERVISOR is absent → parent mode
    expect(isFuzzingMode()).toBe(true);
    expect(process.env["VITIATE_SUPERVISOR"]).toBeUndefined();
  });

  it("child mode condition: VITIATE_FUZZ=1 and VITIATE_SUPERVISOR=1", () => {
    process.env["VITIATE_FUZZ"] = "1";
    process.env["VITIATE_SUPERVISOR"] = "1";

    // isFuzzingMode returns true, VITIATE_SUPERVISOR is present → child mode
    expect(isFuzzingMode()).toBe(true);
    expect(process.env["VITIATE_SUPERVISOR"]).toBe("1");
  });
});

describe("resolveVitestCli", () => {
  it("resolves to a path that exists", () => {
    const cliPath = resolveVitestCli();
    expect(existsSync(cliPath)).toBe(true);
  });

  it("resolves to a path inside the vitest package directory", () => {
    const cliPath = resolveVitestCli();
    expect(cliPath).toContain(path.join("node_modules", "vitest"));
    expect(cliPath).toMatch(/\.[cm]?js$/);
  });
});

describe("buildTestNamePatternFromNames", () => {
  it("matches a top-level test name", () => {
    const pattern = new RegExp(buildTestNamePatternFromNames(["my-test"]));
    expect(pattern.test("my-test")).toBe(true);
    expect(pattern.test("my-test extra")).toBe(false);
    expect(pattern.test("other my-test")).toBe(false);
  });

  it("matches a test inside a describe block", () => {
    const pattern = new RegExp(
      buildTestNamePatternFromNames(["fuzz", "parse-json"]),
    );
    expect(pattern.test("fuzz parse-json")).toBe(true);
    expect(pattern.test("parse-json")).toBe(false);
  });

  it("matches a deeply nested test", () => {
    const pattern = new RegExp(
      buildTestNamePatternFromNames(["outer", "inner", "deep-test"]),
    );
    expect(pattern.test("outer inner deep-test")).toBe(true);
    expect(pattern.test("inner deep-test")).toBe(false);
  });

  it("rejects a test at a different hierarchy level", () => {
    // Pattern for "suite test" should not match "test" (no suite)
    const withSuite = new RegExp(
      buildTestNamePatternFromNames(["suite", "test"]),
    );
    expect(withSuite.test("test")).toBe(false);

    // Pattern for "test" should not match "suite test"
    const withoutSuite = new RegExp(buildTestNamePatternFromNames(["test"]));
    expect(withoutSuite.test("suite test")).toBe(false);
  });

  it("escapes regex metacharacters in names", () => {
    const pattern = new RegExp(
      buildTestNamePatternFromNames([
        "parse (JSON)",
        "handle [brackets]",
        "file.name*glob+plus",
      ]),
    );
    // Exact match with metacharacters
    expect(
      pattern.test("parse (JSON) handle [brackets] file.name*glob+plus"),
    ).toBe(true);
    // Metacharacters should not act as regex operators
    expect(pattern.test("parse JSON handle brackets fileXnameYglobZplus")).toBe(
      false,
    );
  });
});
