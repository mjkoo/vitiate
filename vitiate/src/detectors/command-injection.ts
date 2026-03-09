/**
 * Command injection detector: hooks child_process functions and checks
 * for a goal string in command arguments.
 */
import type { Detector } from "./types.js";
import { VulnerabilityError } from "./vulnerability-error.js";
import { installHook, type ModuleHook } from "./module-hook.js";

const ENCODER = new TextEncoder();

const GOAL_STRING = "vitiate_cmd_inject";

const TOKENS = [GOAL_STRING, ";", "|", "&&", "||", "`", "$(", ">", "<", "\n"];

/** Functions where only the first arg (command string) is checked. */
const COMMAND_STRING_FUNCTIONS = ["exec", "execSync"];

/** Functions where both first arg and args array are checked. */
const COMMAND_AND_ARGS_FUNCTIONS = [
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "fork",
];

function containsGoalString(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes(GOAL_STRING);
  }
  return false;
}

function argsContainGoalString(args: unknown): boolean {
  if (Array.isArray(args)) {
    return args.some((arg) => containsGoalString(arg));
  }
  return false;
}

export class CommandInjectionDetector implements Detector {
  readonly name = "command-injection";
  readonly tier = 1 as const;

  private hooks: ModuleHook[] = [];

  getTokens(): Uint8Array[] {
    return TOKENS.map((t) => ENCODER.encode(t));
  }

  setup(): void {
    for (const fn of COMMAND_STRING_FUNCTIONS) {
      this.hooks.push(
        installHook("child_process", fn, (...args: unknown[]) => {
          const command = args[0];
          if (containsGoalString(command)) {
            throw new VulnerabilityError(this.name, "Command Injection", {
              function: fn,
              command,
              goalString: GOAL_STRING,
            });
          }
        }),
      );
    }

    for (const fn of COMMAND_AND_ARGS_FUNCTIONS) {
      this.hooks.push(
        installHook("child_process", fn, (...args: unknown[]) => {
          const command = args[0];
          const commandArgs = args[1];
          if (
            containsGoalString(command) ||
            argsContainGoalString(commandArgs)
          ) {
            throw new VulnerabilityError(this.name, "Command Injection", {
              function: fn,
              command,
              args: commandArgs,
              goalString: GOAL_STRING,
            });
          }
        }),
      );
    }
  }

  beforeIteration(): void {
    // No-op: module-hook detector throws during execution.
  }

  afterIteration(): void {
    // No-op: module-hook detector throws during execution.
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
}
