/**
 * Crash deduplication: normalize V8 stack traces and compute dedup keys.
 */
import { createHash } from "node:crypto";
import { ExitKind } from "vitiate-napi";

/**
 * Parse V8 stack traces, strip line/column numbers, remove async prefixes,
 * extract top 5 `functionName@fileName` frames, and return the joined string.
 * Returns `undefined` if no frames parse.
 */
export function normalizeStackForDedup(stack: string): string | undefined {
  const lines = stack.split("\n");
  const frames: string[] = [];

  for (const line of lines) {
    if (frames.length >= 5) break;

    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;

    // Strip "at " prefix
    let rest = trimmed.slice(3);

    // Strip "async " prefix
    if (rest.startsWith("async ")) {
      rest = rest.slice(6);
    }

    // Try eval frame: eval (eval at fn (filePath:line:col), <anonymous>:line:col)
    const evalMatch = rest.match(
      /^eval \(eval at \S+ \((.+):\d+:\d+\),\s*<anonymous>:\d+:\d+\)$/,
    );
    if (evalMatch) {
      frames.push(`eval@${evalMatch[1]}`);
      continue;
    }

    // Try "new Constructor" prefix
    let funcName = "";
    let locationPart = rest;

    if (rest.startsWith("new ")) {
      // "new Constructor (filePath:line:col)"
      const parenIdx = rest.indexOf(" (");
      if (parenIdx !== -1) {
        funcName = rest.slice(0, parenIdx);
        locationPart = rest.slice(parenIdx + 2, -1); // strip parens
      } else {
        // "new Constructor filePath:line:col" (no parens — bare path)
        const spaceIdx = rest.indexOf(" ", 4);
        if (spaceIdx !== -1) {
          funcName = rest.slice(0, spaceIdx);
          locationPart = rest.slice(spaceIdx + 1);
        }
      }
    } else if (rest.includes(" (")) {
      // "functionName (filePath:line:col)"
      const parenIdx = rest.indexOf(" (");
      funcName = rest.slice(0, parenIdx);
      locationPart = rest.slice(parenIdx + 2, -1); // strip parens
    } else {
      // "filePath:line:col" (anonymous — no function name, no parens)
      funcName = "";
      locationPart = rest;
    }

    // Extract file path by stripping trailing :line:col
    const fileMatch = locationPart.match(/^(.+):\d+:\d+$/);
    if (!fileMatch) continue;

    const fileName = fileMatch[1];
    frames.push(`${funcName}@${fileName}`);
  }

  if (frames.length === 0) return undefined;
  return frames.join("\n");
}

/**
 * Compute a dedup key for a crash. Returns SHA-256 hex of the normalized
 * stack for Crash exits with valid stacks, or `undefined` for timeouts,
 * missing stacks, or unparseable stacks.
 */
export function computeDedupKey(
  exitKind: ExitKind,
  error: Error | undefined,
): string | undefined {
  if (exitKind !== ExitKind.Crash) return undefined;
  if (!error?.stack) return undefined;

  const normalized = normalizeStackForDedup(error.stack);
  if (normalized === undefined) return undefined;

  return createHash("sha256").update(normalized).digest("hex");
}
