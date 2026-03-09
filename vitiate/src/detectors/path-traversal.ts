/**
 * Path traversal detector: hooks fs functions and checks whether resolved
 * path arguments escape a configured sandbox root.
 */
import nodePath from "node:path";
import type { Detector } from "./types.js";
import { VulnerabilityError } from "./vulnerability-error.js";
import { installHook, type ModuleHook } from "./module-hook.js";

const ENCODER = new TextEncoder();

/** Functions where the first argument is a path. */
const SINGLE_PATH_FUNCTIONS = [
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "open",
  "openSync",
  "access",
  "accessSync",
  "stat",
  "statSync",
  "lstat",
  "lstatSync",
  "readdir",
  "readdirSync",
  "unlink",
  "unlinkSync",
  "rmdir",
  "rmdirSync",
  "mkdir",
  "mkdirSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
];

/** Functions where the first two arguments are paths. */
const DUAL_PATH_FUNCTIONS = [
  "copyFile",
  "copyFileSync",
  "rename",
  "renameSync",
  "link",
  "linkSync",
  "symlink",
  "symlinkSync",
];

/** Static traversal tokens always included. */
const STATIC_TOKENS = [
  "../",
  "../../",
  "../../../",
  "..\\",
  "\x00",
  "%2e%2e%2f",
  "%2e%2e/",
  "..%2f",
];

function isPathEscaping(pathArg: unknown, resolvedRoot: string): boolean {
  if (typeof pathArg !== "string" && !Buffer.isBuffer(pathArg)) {
    return false;
  }
  const pathStr = typeof pathArg === "string" ? pathArg : pathArg.toString();

  const resolved = nodePath.resolve(pathStr);
  // Must equal root or be a child of root (root + sep prefix)
  if (resolved === resolvedRoot) return false;
  if (resolved.startsWith(resolvedRoot + nodePath.sep)) return false;
  return true;
}

export class PathTraversalDetector implements Detector {
  readonly name = "path-traversal";
  readonly tier = 1 as const;

  private readonly sandboxRoot: string;
  private readonly resolvedRoot: string;
  private hooks: ModuleHook[] = [];

  constructor(sandboxRoot?: string) {
    this.sandboxRoot = sandboxRoot ?? process.cwd();
    this.resolvedRoot = nodePath.resolve(this.sandboxRoot);
  }

  getTokens(): Uint8Array[] {
    const tokens = STATIC_TOKENS.map((t) => ENCODER.encode(t));

    // Config-dependent tokens
    tokens.push(ENCODER.encode(this.sandboxRoot));

    // Generate traversal sequence matching sandbox depth
    const depth = this.resolvedRoot.split(nodePath.sep).filter(Boolean).length;
    if (depth > 0) {
      const traversal = "../".repeat(depth) + "etc/passwd";
      tokens.push(ENCODER.encode(traversal));
    }

    return tokens;
  }

  setup(): void {
    for (const fn of SINGLE_PATH_FUNCTIONS) {
      this.hooks.push(
        installHook("fs", fn, (...args: unknown[]) => {
          this.checkPath(args[0], fn, "path");
        }),
      );
    }

    for (const fn of DUAL_PATH_FUNCTIONS) {
      this.hooks.push(
        installHook("fs", fn, (...args: unknown[]) => {
          this.checkPath(args[0], fn, "source");
          this.checkPath(args[1], fn, "destination");
        }),
      );
    }
  }

  beforeIteration(): void {
    // No-op: module-hook detector.
  }

  afterIteration(): void {
    // No-op: module-hook detector.
  }

  resetIteration(): void {
    // No-op: module-hook detector has no per-iteration state.
  }

  teardown(): void {
    for (const hook of this.hooks) {
      hook.restore();
    }
    this.hooks = [];
  }

  /** Check a path argument; throws VulnerabilityError if it escapes the sandbox. */
  private checkPath(
    pathArg: unknown,
    functionName: string,
    argumentName: string,
  ): void {
    if (typeof pathArg !== "string" && !Buffer.isBuffer(pathArg)) {
      return;
    }

    const pathStr = typeof pathArg === "string" ? pathArg : pathArg.toString();
    const hasNullByte = pathStr.includes("\x00");

    if (hasNullByte) {
      throw new VulnerabilityError(this.name, "Path Traversal", {
        function: functionName,
        argument: argumentName,
        path: pathStr,
        sandboxRoot: this.resolvedRoot,
        nullByte: true,
      });
    }

    if (isPathEscaping(pathArg, this.resolvedRoot)) {
      throw new VulnerabilityError(this.name, "Path Traversal", {
        function: functionName,
        argument: argumentName,
        path: pathStr,
        resolvedPath: nodePath.resolve(pathStr),
        sandboxRoot: this.resolvedRoot,
      });
    }
  }
}
