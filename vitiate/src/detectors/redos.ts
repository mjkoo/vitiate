/**
 * ReDoS attribution detector: hooks regex execution methods and measures
 * wall-clock time per call. Throws VulnerabilityError when a single
 * operation exceeds a configurable threshold.
 */
import type { Detector } from "./types.js";
import { VulnerabilityError } from "./vulnerability-error.js";
import { isDetectorActive, stashAndRethrow } from "./module-hook.js";

const ENCODER = new TextEncoder();

const DEFAULT_THRESHOLD_MS = 100;

const MAX_INPUT_LENGTH = 1024;

const TOKENS = [
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!",
  "a]a]a]a]a]a]a]a]a]a]a]a]a]!",
  "\t\t\t\t\t\t\t\t\t\t\t\t\t!",
  "                              !",
];

interface OriginalMethods {
  regexpExec: typeof RegExp.prototype.exec;
  regexpTest: typeof RegExp.prototype.test;
  stringMatch: typeof String.prototype.match;
  stringReplace: typeof String.prototype.replace;
  stringReplaceAll: typeof String.prototype.replaceAll;
  stringMatchAll: typeof String.prototype.matchAll;
  stringSearch: typeof String.prototype.search;
  stringSplit: typeof String.prototype.split;
}

export class RedosDetector implements Detector {
  readonly name = "redos";
  readonly tier = 2 as const;

  private readonly thresholdMs: number;
  private originals: OriginalMethods | undefined;

  constructor(thresholdMs?: number) {
    this.thresholdMs = thresholdMs ?? DEFAULT_THRESHOLD_MS;
  }

  getTokens(): Uint8Array[] {
    return TOKENS.map((t) => ENCODER.encode(t));
  }

  setup(): void {
    if (this.originals !== undefined) {
      throw new Error("RedosDetector.setup() called twice without teardown()");
    }
    this.originals = {
      regexpExec: RegExp.prototype.exec,
      regexpTest: RegExp.prototype.test,
      stringMatch: String.prototype.match,
      stringMatchAll: String.prototype.matchAll,
      stringReplace: String.prototype.replace,
      stringReplaceAll: String.prototype.replaceAll,
      stringSearch: String.prototype.search,
      stringSplit: String.prototype.split,
    };

    const fireVulnerability = this.fireVulnerability.bind(this);
    const { thresholdMs } = this;
    const orig = this.originals;

    // RegExp.prototype.exec
    RegExp.prototype.exec = function (this: RegExp, input: string) {
      if (!isDetectorActive()) {
        return orig.regexpExec.call(this, input);
      }
      const start = performance.now();
      const result = orig.regexpExec.call(this, input);
      const elapsed = performance.now() - start;
      if (elapsed >= thresholdMs) {
        fireVulnerability("exec", this, input, elapsed);
      }
      return result;
    };

    // RegExp.prototype.test
    RegExp.prototype.test = function (this: RegExp, input: string) {
      if (!isDetectorActive()) {
        return orig.regexpTest.call(this, input);
      }
      const start = performance.now();
      const result = orig.regexpTest.call(this, input);
      const elapsed = performance.now() - start;
      if (elapsed >= thresholdMs) {
        fireVulnerability("test", this, input, elapsed);
      }
      return result;
    };

    // Helper to create a String.prototype wrapper that times regex operations.
    type StringMethodFn = (...args: never[]) => unknown;
    function wrapStringMethod<T extends StringMethodFn>(
      original: T,
      method: string,
    ): T {
      const origFn = original as unknown as (...a: unknown[]) => unknown;
      return function (this: string, ...args: unknown[]) {
        const firstArg = args[0];
        if (!isDetectorActive() || !(firstArg instanceof RegExp)) {
          return origFn.apply(this, args);
        }
        const start = performance.now();
        const result = origFn.apply(this, args);
        const elapsed = performance.now() - start;
        if (elapsed >= thresholdMs) {
          fireVulnerability(method, firstArg, this, elapsed);
        }
        return result;
      } as unknown as T;
    }

    String.prototype.match = wrapStringMethod(orig.stringMatch, "match");
    String.prototype.matchAll = wrapStringMethod(
      orig.stringMatchAll,
      "matchAll",
    );
    String.prototype.replace = wrapStringMethod(orig.stringReplace, "replace");
    String.prototype.replaceAll = wrapStringMethod(
      orig.stringReplaceAll,
      "replaceAll",
    );
    String.prototype.search = wrapStringMethod(orig.stringSearch, "search");
    String.prototype.split = wrapStringMethod(orig.stringSplit, "split");
  }

  private fireVulnerability(
    method: string,
    regex: RegExp,
    input: string,
    elapsedMs: number,
  ): never {
    const truncatedInput =
      input.length > MAX_INPUT_LENGTH
        ? input.slice(0, MAX_INPUT_LENGTH)
        : input;
    const error = new VulnerabilityError(this.name, "ReDoS", {
      pattern: regex.source,
      flags: regex.flags,
      input: truncatedInput,
      elapsedMs,
      method,
    });
    stashAndRethrow(error);
  }

  beforeIteration(): void {
    // No-op: fires during target execution.
  }

  afterIteration(): void {
    // No-op: fires during target execution.
  }

  resetIteration(): void {
    // No-op: no per-iteration state.
  }

  teardown(): void {
    if (this.originals === undefined) return;
    RegExp.prototype.exec = this.originals.regexpExec;
    RegExp.prototype.test = this.originals.regexpTest;
    String.prototype.match = this.originals.stringMatch;
    String.prototype.matchAll = this.originals.stringMatchAll;
    String.prototype.replace = this.originals.stringReplace;
    String.prototype.replaceAll = this.originals.stringReplaceAll;
    String.prototype.search = this.originals.stringSearch;
    String.prototype.split = this.originals.stringSplit;
    this.originals = undefined;
  }
}
