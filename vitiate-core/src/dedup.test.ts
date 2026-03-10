import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { normalizeStackForDedup, computeDedupKey } from "./dedup.js";
import { ExitKind } from "@vitiate/engine";

describe("normalizeStackForDedup", () => {
  it("parses standard V8 stack frames with named functions", () => {
    const stack = [
      "Error: something broke",
      "    at foo (/path/to/file.js:10:5)",
      "    at bar (/other/file.js:20:3)",
    ].join("\n");

    expect(normalizeStackForDedup(stack)).toBe(
      "foo@/path/to/file.js\nbar@/other/file.js",
    );
  });

  it("handles anonymous function frames", () => {
    const stack = ["Error: boom", "    at /path/to/file.js:10:5"].join("\n");

    expect(normalizeStackForDedup(stack)).toBe("@/path/to/file.js");
  });

  it("strips async prefix from frames", () => {
    const stack = [
      "Error: async boom",
      "    at async processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ].join("\n");

    expect(normalizeStackForDedup(stack)).toBe(
      "processTicksAndRejections@node:internal/process/task_queues",
    );
  });

  it("truncates to top 5 frames", () => {
    const lines = ["Error: too many frames"];
    for (let i = 1; i <= 10; i++) {
      lines.push(`    at fn${i} (/file${i}.js:${i}:1)`);
    }
    const stack = lines.join("\n");

    const result = normalizeStackForDedup(stack)!;
    expect(result.split("\n")).toHaveLength(5);
    expect(result).toBe(
      "fn1@/file1.js\nfn2@/file2.js\nfn3@/file3.js\nfn4@/file4.js\nfn5@/file5.js",
    );
  });

  it("returns undefined for unparseable stacks", () => {
    expect(normalizeStackForDedup("no frames here")).toBeUndefined();
    expect(normalizeStackForDedup("Error: just a message")).toBeUndefined();
    expect(normalizeStackForDedup("")).toBeUndefined();
  });

  it("excludes error message line", () => {
    const stack = [
      "Error: this should not appear in output",
      "    at myFunc (/src/app.js:42:10)",
    ].join("\n");

    const result = normalizeStackForDedup(stack)!;
    expect(result).not.toContain("Error:");
    expect(result).toBe("myFunc@/src/app.js");
  });

  it("same bug with different line numbers produces identical output", () => {
    const stack1 = [
      "Error: crash",
      "    at foo (/src/app.js:10:5)",
      "    at bar (/src/lib.js:20:3)",
    ].join("\n");
    const stack2 = [
      "Error: crash",
      "    at foo (/src/app.js:99:15)",
      "    at bar (/src/lib.js:200:30)",
    ].join("\n");

    expect(normalizeStackForDedup(stack1)).toBe(normalizeStackForDedup(stack2));
  });

  it("preserves Type.method for method calls", () => {
    const stack = [
      "Error: method crash",
      "    at MyClass.doSomething (/path/to/file.js:10:5)",
    ].join("\n");

    expect(normalizeStackForDedup(stack)).toBe(
      "MyClass.doSomething@/path/to/file.js",
    );
  });

  it("preserves new Constructor for constructor calls", () => {
    const stack = [
      "Error: constructor crash",
      "    at new MyClass (/path/to/file.js:10:5)",
    ].join("\n");

    expect(normalizeStackForDedup(stack)).toBe("new MyClass@/path/to/file.js");
  });

  it("preserves Object.<anonymous>", () => {
    const stack = [
      "Error: anon crash",
      "    at Object.<anonymous> (/path/to/file.js:10:5)",
    ].join("\n");

    expect(normalizeStackForDedup(stack)).toBe(
      "Object.<anonymous>@/path/to/file.js",
    );
  });

  it("handles eval frames with outer file path", () => {
    const stack = [
      "Error: eval crash",
      "    at eval (eval at myFunc (/path/to/file.js:10:5), <anonymous>:1:1)",
    ].join("\n");

    expect(normalizeStackForDedup(stack)).toBe("eval@/path/to/file.js");
  });

  it("handles eval frames with node: scheme outer path", () => {
    const stack = [
      "Error: eval crash",
      "    at eval (eval at myFunc (node:internal/process/task_queues:10:5), <anonymous>:1:1)",
    ].join("\n");

    expect(normalizeStackForDedup(stack)).toBe(
      "eval@node:internal/process/task_queues",
    );
  });

  it("handles bare node: scheme paths without parens", () => {
    const stack = [
      "Error: boom",
      "    at node:internal/process/task_queues:95:5",
    ].join("\n");

    expect(normalizeStackForDedup(stack)).toBe(
      "@node:internal/process/task_queues",
    );
  });

  it("handles mixed frame types", () => {
    const stack = [
      "RangeError: Maximum call stack size exceeded",
      "    at new Parser (/src/parser.js:5:1)",
      "    at Parser.parse (/src/parser.js:20:10)",
      "    at async handleRequest (/src/server.js:100:3)",
      "    at Object.<anonymous> (/src/index.js:1:1)",
      "    at /src/bootstrap.js:10:5",
    ].join("\n");

    expect(normalizeStackForDedup(stack)).toBe(
      [
        "new Parser@/src/parser.js",
        "Parser.parse@/src/parser.js",
        "handleRequest@/src/server.js",
        "Object.<anonymous>@/src/index.js",
        "@/src/bootstrap.js",
      ].join("\n"),
    );
  });
});

describe("computeDedupKey", () => {
  it("returns SHA-256 hex string for Crash with valid stack", () => {
    const error = new Error("test crash");
    const key = computeDedupKey(ExitKind.Crash, error);

    expect(key).toBeDefined();
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    // Verify it's the hash of the normalized stack
    const normalized = normalizeStackForDedup(error.stack!);
    const expected = createHash("sha256").update(normalized!).digest("hex");
    expect(key).toBe(expected);
  });

  it("returns undefined for Crash without stack", () => {
    const error = new Error("no stack");
    delete error.stack;
    expect(computeDedupKey(ExitKind.Crash, error)).toBeUndefined();
  });

  it("returns undefined for Crash with empty stack", () => {
    const error = new Error("empty stack");
    error.stack = "";
    expect(computeDedupKey(ExitKind.Crash, error)).toBeUndefined();
  });

  it("returns undefined for Crash with unparseable stack", () => {
    const error = new Error("bad stack");
    error.stack = "no frames here at all";
    expect(computeDedupKey(ExitKind.Crash, error)).toBeUndefined();
  });

  it("returns undefined for Timeout", () => {
    const error = new Error("timed out");
    expect(computeDedupKey(ExitKind.Timeout, error)).toBeUndefined();
  });

  it("returns undefined for Timeout even with valid stack", () => {
    const error = new Error("timed out");
    // error.stack is a valid V8 stack, but Timeout should always return undefined
    expect(computeDedupKey(ExitKind.Timeout, error)).toBeUndefined();
  });

  it("returns undefined when error is undefined", () => {
    expect(computeDedupKey(ExitKind.Crash, undefined)).toBeUndefined();
  });

  it("returns same key for same bug at different lines", () => {
    const error1 = new Error("crash");
    const error2 = new Error("crash");
    // Both errors created in the same function context will have the same
    // function names and file paths, just potentially different line numbers.
    // Since we strip line/col, they should produce the same key.
    const key1 = computeDedupKey(ExitKind.Crash, error1);
    const key2 = computeDedupKey(ExitKind.Crash, error2);
    expect(key1).toBe(key2);
  });
});
