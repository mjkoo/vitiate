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
  readonly tier = 1 as const;

  private originalEval: typeof globalThis.eval | undefined;
  private originalFunction: typeof globalThis.Function | undefined;
  private originalFunctionConstructor: FunctionConstructor | undefined;
  private originalSetTimeout: typeof globalThis.setTimeout | undefined;
  private originalSetInterval: typeof globalThis.setInterval | undefined;

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
      // Safe cast: origEval accepts string|undefined. The typeof check above
      // handles the string case; for non-string x, eval returns it unchanged.
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

    // Patch .constructor on the prototype so (function(){}).constructor("...")
    // goes through the wrapper, not the original Function. Safe cast:
    // origFunction.prototype.constructor is always the Function constructor.
    this.originalFunctionConstructor = origFunction.prototype
      .constructor as FunctionConstructor;
    origFunction.prototype.constructor = FunctionWrapper;

    globalThis.Function = FunctionWrapper;

    // Hook setTimeout and setInterval - both accept string first arguments
    // that are eval'd. Use installHook-style wrapping via the global object
    // to avoid complex Node.js timer type overloads.
    this.originalSetTimeout = globalThis.setTimeout;
    this.originalSetInterval = globalThis.setInterval;

    const wrapTimer = (
      original: (...args: unknown[]) => unknown,
      name: string,
    ): ((...args: unknown[]) => unknown) => {
      return function (this: unknown, ...args: unknown[]): unknown {
        const callback = args[0];
        if (
          isDetectorActive() &&
          typeof callback === "string" &&
          callback.includes(GOAL_STRING)
        ) {
          const error = new VulnerabilityError("unsafe-eval", "Unsafe Eval", {
            function: name,
            code: callback,
            goalString: GOAL_STRING,
          });
          stashAndRethrow(error);
        }
        return Reflect.apply(original, this, args);
      };
    };

    // Safe cast: the wrapper preserves calling convention. The complex overloaded
    // timer types don't affect the runtime behavior - we just intercept string args.
    (globalThis as Record<string, unknown>)["setTimeout"] = wrapTimer(
      this.originalSetTimeout as unknown as (...args: unknown[]) => unknown,
      "setTimeout",
    );
    (globalThis as Record<string, unknown>)["setInterval"] = wrapTimer(
      this.originalSetInterval as unknown as (...args: unknown[]) => unknown,
      "setInterval",
    );
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
      // Restore .constructor before restoring Function itself
      if (this.originalFunctionConstructor !== undefined) {
        this.originalFunction.prototype.constructor =
          this.originalFunctionConstructor;
        this.originalFunctionConstructor = undefined;
      }
      globalThis.Function = this.originalFunction;
      this.originalFunction = undefined;
    }
    if (this.originalSetTimeout !== undefined) {
      globalThis.setTimeout = this.originalSetTimeout;
      this.originalSetTimeout = undefined;
    }
    if (this.originalSetInterval !== undefined) {
      globalThis.setInterval = this.originalSetInterval;
      this.originalSetInterval = undefined;
    }
  }
}
