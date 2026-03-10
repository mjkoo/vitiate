/**
 * Shared supervisor module: manages child process lifecycle for fuzzing.
 *
 * Used by both the CLI entry point and the fuzz() test callback to provide
 * crash-resilient fuzzing with shmem input stashing and child respawn.
 */
import type { ChildProcess } from "node:child_process";
import type { ShmemHandle } from "@vitiate/engine";
import { watchdogExitCode } from "@vitiate/engine";
import {
  writeArtifact,
  writeArtifactWithPrefix,
  type ArtifactKind,
} from "./corpus.js";

/**
 * Exit code used by the watchdog's `_exit` fallback for timeouts.
 * Sourced from the Rust watchdog module via napi-rs (single source of truth).
 */
export const WATCHDOG_EXIT_CODE = watchdogExitCode();

/**
 * Maximum number of child respawns before the parent gives up.
 * Prevents infinite respawn loops from runaway native crashes.
 */
export const MAX_RESPAWNS = 100;

export interface SupervisorOptions {
  shmem: ShmemHandle;
  testDir: string;
  testName: string;
  artifactPrefix?: string;
  spawnChild: () => ChildProcess;
  maxRespawns?: number;
}

export interface SupervisorResult {
  crashed: boolean;
  /**
   * Path to the crash/timeout artifact written by the parent from shmem.
   * Only populated for signal-death and watchdog-timeout crashes (where the
   * parent recovers the input). For JS-level crashes (exit code 1), the
   * child writes the artifact directly and this field is undefined.
   */
  crashArtifactPath?: string;
  signal?: string;
  exitCode?: number;
}

/**
 * Wait for a child process to exit. Returns the exit code and signal.
 * Rejects if the child fails to spawn (e.g., binary not found).
 */
export function waitForChild(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", (err) => {
      child.removeAllListeners("exit");
      reject(err);
    });
    child.once("exit", (code, signal) => {
      child.removeAllListeners("error");
      resolve({ code, signal });
    });
  });
}

/**
 * Run the supervisor wait/respawn loop. Spawns a child process, waits for
 * it to exit, handles crashes (signal death, watchdog timeout), writes
 * crash artifacts from shmem, and respawns.
 */
export async function runSupervisor(
  options: SupervisorOptions,
): Promise<SupervisorResult> {
  const {
    shmem,
    testDir,
    testName,
    artifactPrefix,
    spawnChild,
    maxRespawns = MAX_RESPAWNS,
  } = options;

  // SIGINT handling: the kernel delivers SIGINT to the entire foreground
  // process group, so the child already receives it. We only need the flag
  // to avoid interpreting the child's SIGINT-caused exit as a crash.
  let sigintReceived = false;

  const sigintHandler = (): void => {
    sigintReceived = true;
  };
  process.on("SIGINT", sigintHandler);

  let respawnCount = 0;

  try {
    while (true) {
      const child = spawnChild();

      const { code, signal } = await waitForChild(child);

      if (sigintReceived) {
        // Parent received SIGINT — exit cleanly (130 = conventional SIGINT exit)
        return { crashed: false, exitCode: code ?? 130 };
      }

      if (signal !== null) {
        // Child was killed by a signal — native crash
        process.stderr.write(`vitiate: child killed by signal ${signal}\n`);

        const result = recoverAndRespawn(
          shmem,
          testDir,
          testName,
          "crash",
          respawnCount,
          maxRespawns,
          artifactPrefix,
        );
        if (result.limitReached) {
          return {
            crashed: true,
            crashArtifactPath: result.crashArtifactPath,
            signal,
          };
        }
        respawnCount++;
        continue;
      }

      // Child exited with a code
      if (code === 0) {
        // Campaign complete — no crash found or limits reached
        return { crashed: false, exitCode: 0 };
      }

      if (code === 1) {
        // JS crash found — artifact was written by the child
        return { crashed: true, exitCode: 1 };
      }

      if (code === WATCHDOG_EXIT_CODE) {
        // Watchdog timeout — attempt backup recovery from shmem
        process.stderr.write("vitiate: child exited with watchdog timeout\n");

        const result = recoverAndRespawn(
          shmem,
          testDir,
          testName,
          "timeout",
          respawnCount,
          maxRespawns,
          artifactPrefix,
        );
        if (result.limitReached) {
          return {
            crashed: true,
            crashArtifactPath: result.crashArtifactPath,
            exitCode: WATCHDOG_EXIT_CODE,
          };
        }
        respawnCount++;
        continue;
      }

      // Unknown exit code — forward as-is
      return { crashed: false, exitCode: code ?? 1 };
    }
  } finally {
    process.removeListener("SIGINT", sigintHandler);
  }
}

/**
 * Recover the crashing input from shmem, write an artifact, reset the
 * generation counter, and check whether the respawn limit has been reached.
 */
function recoverAndRespawn(
  shmem: ShmemHandle,
  testDir: string,
  testName: string,
  kind: ArtifactKind,
  respawnCount: number,
  maxRespawns: number,
  artifactPrefix?: string,
): { crashArtifactPath: string | undefined; limitReached: boolean } {
  let crashArtifactPath: string | undefined;
  const input = shmem.readStashedInput();
  if (input.length > 0) {
    crashArtifactPath =
      artifactPrefix !== undefined
        ? writeArtifactWithPrefix(artifactPrefix, input, kind)
        : writeArtifact(testDir, testName, input, kind);
    process.stderr.write(
      `vitiate: ${kind} artifact written to ${crashArtifactPath}\n`,
    );
  }
  shmem.resetGeneration();

  if (respawnCount + 1 >= maxRespawns) {
    process.stderr.write(
      `vitiate: respawn limit (${maxRespawns}) exceeded, giving up\n`,
    );
    return { crashArtifactPath, limitReached: true };
  }

  process.stderr.write("vitiate: respawning child to continue fuzzing\n");
  return { crashArtifactPath, limitReached: false };
}
