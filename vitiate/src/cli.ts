/**
 * Standalone CLI: npx vitiate <test-file> [corpus_dirs...] [flags]
 *
 * Operates in two modes:
 * - **Parent mode** (default): Allocates shmem, spawns itself as a child with
 *   `VITIATE_SUPERVISOR` set, and enters a wait loop. On native crash, reads
 *   the crashing input from shmem, writes a crash artifact, and respawns.
 * - **Child mode** (`VITIATE_SUPERVISOR` set): Attaches to shmem, starts Vitest
 *   in fuzzing mode, and runs the fuzz loop.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { object } from "@optique/core/constructs";
import { option, argument } from "@optique/core/primitives";
import { integer, string } from "@optique/core/valueparser";
import { optional, multiple, withDefault } from "@optique/core/modifiers";
import { type InferValue, parseSync } from "@optique/core/parser";
import { formatMessage } from "@optique/core/message";
import { runSync } from "@optique/run";
import { ShmemHandle } from "vitiate-napi";
import { vitiatePlugin } from "./plugin.js";
import { writeCrashArtifact } from "./corpus.js";
import type { FuzzOptions } from "./config.js";

export interface CliArgs {
  testFile: string;
  corpusDirs: string[];
  fuzzOptions: FuzzOptions;
}

export const cliParser = object({
  testFile: argument(string({ metavar: "TEST_FILE" })),
  corpusDirs: withDefault(
    multiple(argument(string({ metavar: "CORPUS_DIR", pattern: /^[^-]/ }))),
    [],
  ),
  maxLen: optional(option("-max_len", integer({ min: 1 }))),
  timeout: optional(option("-timeout", integer({ min: 0 }))),
  runs: optional(option("-runs", integer({ min: 0 }))),
  seed: optional(option("-seed", integer())),
  maxTotalTime: optional(option("-max_total_time", integer({ min: 0 }))),
});

function toCliArgs(parsed: InferValue<typeof cliParser>): CliArgs {
  const { testFile, corpusDirs, maxLen, timeout, runs, seed, maxTotalTime } =
    parsed;
  return {
    testFile,
    corpusDirs: [...corpusDirs],
    fuzzOptions: {
      maxLen,
      timeoutMs: timeout != null ? timeout * 1000 : undefined,
      runs,
      seed,
      maxTotalTimeMs: maxTotalTime != null ? maxTotalTime * 1000 : undefined,
    },
  };
}

export function parseArgs(argv: string[]): CliArgs {
  const result = parseSync(cliParser, argv.slice(2));
  if (!result.success) {
    throw new Error(formatMessage(result.error));
  }
  return toCliArgs(result.value);
}

/**
 * Exit code used by the watchdog's `_exit` fallback for timeouts.
 * Must be kept in sync with `WATCHDOG_EXIT_CODE` in `vitiate-napi/src/watchdog.rs`.
 */
export const WATCHDOG_EXIT_CODE = 77;

/**
 * Maximum number of child respawns before the parent gives up.
 * Prevents infinite respawn loops from runaway native crashes.
 */
export const MAX_RESPAWNS = 100;

/** Default max input length for shmem allocation. */
const DEFAULT_MAX_INPUT_LEN = 4096;

/**
 * Parent supervisor: allocates shmem, spawns the child, enters the
 * wait/respawn loop.
 */
async function runParentMode(
  testFile: string,
  maxInputLen: number,
): Promise<void> {
  // Allocate shmem and export the identifier to the environment
  const shmem = ShmemHandle.allocate(maxInputLen);

  // Resolve the test directory from the test file path for crash artifacts
  const testDir = path.dirname(path.resolve(testFile));

  // Extract test name from the file path for artifact directory naming.
  //
  // Known limitation: the parent derives the test name from the file basename,
  // while the child uses the name passed to `test.fuzz()`. These may differ
  // (e.g., file "parser.test.ts" but test name "parse-planted-bug"). The
  // parent's artifacts serve as a backup recovery path for native crashes that
  // kill the child before it can write its own artifact. The child's artifacts
  // (written by the fuzz loop) use the canonical test name and are the primary
  // source of truth for crash reproduction.
  const testName = path.basename(testFile, path.extname(testFile));

  const spawnChild = (): ChildProcess => {
    return spawn(process.execPath, process.argv.slice(1), {
      env: { ...process.env, VITIATE_SUPERVISOR: "1" },
      stdio: ["ignore", "inherit", "inherit"],
    });
  };

  // SIGINT handling: forward to child, wait for exit, then exit parent
  let currentChild: ChildProcess | null = null;
  let sigintReceived = false;

  const sigintHandler = (): void => {
    sigintReceived = true;
    if (currentChild && currentChild.exitCode === null) {
      currentChild.kill("SIGINT");
    }
  };
  process.on("SIGINT", sigintHandler);

  let respawnCount = 0;

  /**
   * Read the stashed input from shmem, write a crash artifact if present,
   * reset shmem generation, and check the respawn limit.
   *
   * Returns `true` if the respawn limit was hit (caller should exit).
   */
  const handleCrashAndCheckLimit = (
    shmem: ShmemHandle,
    testDir: string,
    testName: string,
  ): boolean => {
    const input = shmem.readStashedInput();
    if (input.length > 0) {
      const artifactPath = writeCrashArtifact(testDir, testName, input);
      process.stderr.write(
        `vitiate: crash artifact written to ${artifactPath}\n`,
      );
    }

    shmem.resetGeneration();

    respawnCount++;
    if (respawnCount >= MAX_RESPAWNS) {
      process.stderr.write(
        `vitiate: respawn limit (${MAX_RESPAWNS}) exceeded, giving up\n`,
      );
      process.exitCode = 1;
      return true;
    }

    return false;
  };

  try {
    // Spawn/wait/respawn loop
    while (true) {
      currentChild = spawnChild();

      const { code, signal } = await waitForChild(currentChild);

      if (sigintReceived) {
        // Parent received SIGINT and forwarded it — exit cleanly
        process.exitCode = code ?? 1;
        return;
      }

      if (signal !== null) {
        // Child was killed by a signal — native crash
        process.stderr.write(`vitiate: child killed by signal ${signal}\n`);

        const limitHit = handleCrashAndCheckLimit(shmem, testDir, testName);
        if (limitHit) return;

        process.stderr.write("vitiate: respawning child to continue fuzzing\n");
        continue;
      }

      // Child exited with a code
      if (code === 0) {
        // Campaign complete — no crash found or limits reached
        process.exitCode = 0;
        return;
      }

      if (code === 1) {
        // JS crash found — artifact was written by the child
        process.exitCode = 1;
        return;
      }

      if (code === WATCHDOG_EXIT_CODE) {
        // Watchdog timeout — the watchdog already wrote an artifact before
        // _exit, but attempt backup recovery from shmem in case it didn't.
        process.stderr.write("vitiate: child exited with watchdog timeout\n");

        const limitHit = handleCrashAndCheckLimit(shmem, testDir, testName);
        if (limitHit) return;

        process.stderr.write("vitiate: respawning child to continue fuzzing\n");
        continue;
      }

      // Unknown exit code — forward as-is
      process.exitCode = code ?? 1;
      return;
    }
  } finally {
    process.removeListener("SIGINT", sigintHandler);
  }
}

/**
 * Wait for a child process to exit. Returns the exit code and signal.
 * Rejects if the child fails to spawn (e.g., binary not found).
 */
export function waitForChild(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

/**
 * Child mode: starts Vitest in fuzzing mode (existing behavior).
 */
async function runChildMode(
  testFile: string,
  corpusDirs: string[],
  fuzzOptions: FuzzOptions,
): Promise<void> {
  // Activate fuzzing mode
  process.env["VITIATE_FUZZ"] = "1";

  // Forward CLI options to fuzz targets via env var
  process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify(fuzzOptions);

  // Forward corpus directories to fuzz targets via env var
  if (corpusDirs.length > 0) {
    process.env["VITIATE_CORPUS_DIRS"] = corpusDirs.join(path.delimiter);
  }

  const { startVitest } = await import("vitest/node");

  const vitest = await startVitest(
    "test",
    [testFile],
    {
      include: [testFile],
      testTimeout: 0,
    },
    {
      plugins: [vitiatePlugin({ instrument: {} })],
    },
  );

  if (vitest) {
    await vitest.close();
  } else {
    process.stderr.write("vitiate: vitest failed to start\n");
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const { testFile, corpusDirs, fuzzOptions } = toCliArgs(
    runSync(cliParser, {
      programName: "vitiate",
      help: "option",
    }),
  );

  if (process.env["VITIATE_SUPERVISOR"]) {
    // Child mode: shmem is already set up by the parent
    await runChildMode(testFile, corpusDirs, fuzzOptions);
  } else {
    // Parent mode: allocate shmem, spawn child, supervise
    const maxInputLen = fuzzOptions.maxLen ?? DEFAULT_MAX_INPUT_LEN;
    await runParentMode(testFile, maxInputLen);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
