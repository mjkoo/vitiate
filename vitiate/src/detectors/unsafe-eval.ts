/**
 * Unsafe eval detector: hooks eval() and Function constructor to detect
 * fuzz input reaching code evaluation via a goal string.
 */
import { type Detector, VulnerabilityError } from "./types.js";
import { isDetectorActive, stashAndRethrow } from "./module-hook.js";

const ENCODER = new TextEncoder();

const GOAL_STRING = "vitiate_eval_inject";

const TOKENS = [GOAL_STRING, 'require("', "process.exit", "import("];

export class UnsafeEvalDetector implements Detector {
  readonly name = "unsafe-eval";
  readonly tier = 2 as const;

  private originalEval: typeof globalThis.eval | undefined;
  private originalFunction: typeof globalThis.Function | undefined;

  getTokens(): Uint8Array[] {
    return TOKENS.map((t) => ENCODER.encode(t));
  }

  setup(): void {
    if (
      this.originalEval !== undefined ||
      this.originalFunction !== undefined
    ) {
      throw new Error(
        "UnsafeEvalDetector.setup() called twice without teardown()",
      );
    }
    this.originalEval = globalThis.eval;
    this.originalFunction = globalThis.Function;

    const origEval = this.originalEval;
    const origFunction = this.originalFunction;

    // Hook eval
    globalThis.eval = function (x?: unknown) {
      if (
        isDetectorActive() &&
        typeof x === "string" &&
        x.includes(GOAL_STRING)
      ) {
        const error = new VulnerabilityError("unsafe-eval", "Unsafe Eval", {
          function: "eval",
          code: x,
          goalString: GOAL_STRING,
        });
        stashAndRethrow(error);
      }
      return origEval(x as string);
    } as typeof eval;

    // Hook Function constructor
    // Must handle both `new Function(...)` and `Function(...)` calling conventions.
    const FunctionWrapper = function (this: unknown, ...args: string[]) {
      if (isDetectorActive()) {
        for (const arg of args) {
          if (typeof arg === "string" && arg.includes(GOAL_STRING)) {
            const error = new VulnerabilityError("unsafe-eval", "Unsafe Eval", {
              function: "Function",
              code: arg,
              goalString: GOAL_STRING,
            });
            stashAndRethrow(error);
          }
        }
      }
      // Use Reflect.construct to handle both `new` and direct call
      return Reflect.construct(origFunction, args, new.target || origFunction);
    } as unknown as FunctionConstructor;

    // Preserve the prototype chain
    Object.defineProperty(FunctionWrapper, "prototype", {
      value: origFunction.prototype,
      writable: true,
      configurable: false,
    });
    Object.setPrototypeOf(FunctionWrapper, origFunction);

    globalThis.Function = FunctionWrapper;
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
    if (this.originalEval !== undefined) {
      globalThis.eval = this.originalEval;
      this.originalEval = undefined;
    }
    if (this.originalFunction !== undefined) {
      globalThis.Function = this.originalFunction;
      this.originalFunction = undefined;
    }
  }
}
