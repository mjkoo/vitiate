/**
 * Shared supervisor module: manages child process lifecycle for fuzzing.
 *
 * Used by both the CLI entry point and the fuzz() test callback to provide
 * crash-resilient fuzzing with shmem input stashing and child respawn.
 */
import type { ChildProcess } from "node:child_process";
import type { ShmemHandle } from "vitiate-napi";
import { writeCrashArtifact } from "./corpus.js";

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

export interface SupervisorOptions {
  shmem: ShmemHandle;
  testDir: string;
  testName: string;
  spawnChild: () => ChildProcess;
  maxRespawns?: number;
}

export interface SupervisorResult {
  crashed: boolean;
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
    child.on("error", reject);
    child.on("exit", (code, signal) => {
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
  let lastCrashArtifactPath: string | undefined;

  try {
    while (true) {
      const child = spawnChild();

      const { code, signal } = await waitForChild(child);

      if (sigintReceived) {
        // Parent received SIGINT — exit cleanly
        return { crashed: false, exitCode: code ?? 1 };
      }

      if (signal !== null) {
        // Child was killed by a signal — native crash
        process.stderr.write(`vitiate: child killed by signal ${signal}\n`);

        lastCrashArtifactPath = handleCrash(shmem, testDir, testName);
        shmem.resetGeneration();

        respawnCount++;
        if (respawnCount >= maxRespawns) {
          process.stderr.write(
            `vitiate: respawn limit (${maxRespawns}) exceeded, giving up\n`,
          );
          return {
            crashed: true,
            crashArtifactPath: lastCrashArtifactPath,
            signal,
          };
        }

        process.stderr.write("vitiate: respawning child to continue fuzzing\n");
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

        lastCrashArtifactPath = handleCrash(shmem, testDir, testName);
        shmem.resetGeneration();

        respawnCount++;
        if (respawnCount >= maxRespawns) {
          process.stderr.write(
            `vitiate: respawn limit (${maxRespawns}) exceeded, giving up\n`,
          );
          return {
            crashed: true,
            crashArtifactPath: lastCrashArtifactPath,
            exitCode: WATCHDOG_EXIT_CODE,
          };
        }

        process.stderr.write("vitiate: respawning child to continue fuzzing\n");
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
 * Read the stashed input from shmem and write a crash artifact if present.
 * Returns the artifact path if an artifact was written.
 */
function handleCrash(
  shmem: ShmemHandle,
  testDir: string,
  testName: string,
): string | undefined {
  const input = shmem.readStashedInput();
  if (input.length > 0) {
    const artifactPath = writeCrashArtifact(testDir, testName, input);
    process.stderr.write(
      `vitiate: crash artifact written to ${artifactPath}\n`,
    );
    return artifactPath;
  }
  return undefined;
}
