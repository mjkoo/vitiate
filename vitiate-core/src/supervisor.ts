/**
 * Shared supervisor module: manages child process lifecycle for fuzzing.
 *
 * Used by both the CLI entry point and the fuzz() test callback to provide
 * crash-resilient fuzzing with shmem input stashing and child respawn.
 */
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ShmemHandle } from "@vitiate/engine";
import { enginePanicExitCode, watchdogExitCode } from "@vitiate/engine";
import {
  getTestDataDir,
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
 * Exit code the engine's panic hook uses when it intercepts a Rust panic.
 * Sourced from the Rust engine via napi-rs (single source of truth). A child
 * exiting with this code means vitiate's own engine panicked - an
 * infrastructure error, NOT a crash in the target under test - so the
 * supervisor does not write a crash artifact or respawn.
 */
export const ENGINE_PANIC_EXIT_CODE = enginePanicExitCode();

/**
 * Maximum number of child respawns before the parent gives up.
 * Prevents infinite respawn loops from runaway native crashes.
 */
export const MAX_RESPAWNS = 100;

/**
 * Maximum number of consecutive respawns that recover NO input before the
 * parent concludes the child is failing at startup (before the fuzz loop ever
 * stashes an input) - or is being killed externally - and bails with a
 * diagnostic instead of storming all the way to {@link MAX_RESPAWNS}.
 */
export const MAX_STARTUP_FAILURES = 3;

/** Signals that indicate a native crash (not user-initiated shutdown). */
const CRASH_SIGNALS = new Set(["SIGSEGV", "SIGBUS", "SIGABRT", "SIGFPE"]);

/**
 * Exit codes that indicate crashes delivered as exit codes rather than signals.
 *
 * Note: 137 (SIGKILL / OOM killer) is intentionally NOT here. SIGKILL is
 * uncatchable and a JS/V8 target cannot raise it as a discovered bug, so it is
 * almost always external (OOM-killer, container/cgroup memory limit, k8s
 * eviction, CI timeout). It is handled separately as an infrastructure error
 * rather than a confirmed crash - see the SIGKILL/137 branch in `runSupervisor`.
 */
const CRASH_EXIT_CODES = new Set([
  134, // SIGABRT (128 + 6)
]);

/**
 * Exit code for a process killed by SIGKILL (128 + 9). Node usually reports a
 * SIGKILL'd child with this exit code, and sometimes as a `SIGKILL` signal;
 * both forms are handled. Treated as an infrastructure failure (OOM-killer,
 * memory limit, eviction, CI timeout), not a target crash.
 */
const SIGKILL_EXIT_CODE = 137;

export interface SupervisorOptions {
  shmem: ShmemHandle;
  relativeTestFilePath: string;
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
  /** True when exit code 1 and the child wrote new crash artifacts this run. */
  newCrashArtifacts?: boolean;
  /**
   * True when the child died due to a panic in vitiate's own engine
   * (intercepted by the engine panic hook and signalled via
   * {@link ENGINE_PANIC_EXIT_CODE}), as opposed to a crash in the target under
   * test. The supervisor does not write a crash artifact or respawn in this
   * case; callers should surface it as an infrastructure failure.
   */
  engineError?: boolean;
  /**
   * True when the finding is a timeout rather than an ordinary crash - either
   * a soft timeout (child exited 1 having written only `timeout-*` artifacts)
   * or a hard watchdog timeout that exhausted respawns. Both still set
   * {@link crashed}; this flag lets the exit-code mapping distinguish them so a
   * timeout can surface libFuzzer's `timeout_exitcode` instead of `error_exitcode`.
   */
  timedOut?: boolean;
  /**
   * True when the child was killed by SIGKILL (exit code 137). This is
   * ambiguous between an environmental kill (OOM-killer, container/cgroup
   * memory limit, k8s eviction, CI timeout) and a possible memory-exhaustion
   * input, so it is surfaced as an infrastructure failure - NOT a confirmed
   * target crash. Any in-flight input is preserved in a segregated `ooms/`
   * bucket ({@link crashArtifactPath}); the supervisor does not respawn.
   */
  oomKilled?: boolean;
  /**
   * True when the child crashed {@link MAX_STARTUP_FAILURES} times in a row
   * without ever stashing a recoverable input - i.e. it is failing at startup
   * (module load, native addon init, vitest setup) before reaching the fuzz
   * loop, or is being killed externally. Surfaced as an infrastructure failure
   * with no crash artifact.
   */
  startupFailure?: boolean;
}

/**
 * Wait for a child process to exit. Returns the exit code and signal.
 * Rejects if the child fails to spawn (e.g., binary not found).
 */
export function waitForChild(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      child.removeListener("exit", onExit);
      reject(err);
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      child.removeListener("error", onError);
      resolve({ code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
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
    relativeTestFilePath,
    testName,
    artifactPrefix,
    spawnChild,
    maxRespawns = MAX_RESPAWNS,
  } = options;

  // SIGINT handling: the kernel delivers SIGINT to the entire foreground
  // process group, so the child already receives it. We only need the flag
  // to avoid interpreting the child's SIGINT-caused exit as a crash.
  let sigintReceived = false;
  let sigtermReceived = false;
  let currentChild: ChildProcess | null = null;

  const sigintHandler = (): void => {
    sigintReceived = true;
  };
  const sigtermHandler = (): void => {
    sigtermReceived = true;
    // Forward SIGTERM to the child so it can shut down gracefully.
    currentChild?.kill("SIGTERM");
  };
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  // Snapshot existing crash/timeout artifacts so we can detect new ones
  // written by the child (exit code 1). Without this, pre-existing regression
  // tests in the artifact dirs would cause false positives.
  //
  // When artifactPrefix is set (CLI mode), the child writes all artifact
  // kinds to <artifactPrefix><kind>-<hash> (flat in the prefix directory).
  // Otherwise the child writes to testdata/<hash>/crashes/crash-<hash> and
  // testdata/<hash>/timeouts/timeout-<hash>. Timeout artifacts count: a
  // timeout-only finding also exits the child with code 1 and must not be
  // misclassified as an infrastructure failure.
  const artifactDirs =
    artifactPrefix !== undefined
      ? [path.dirname(artifactPrefix + "crash-x")]
      : [
          path.join(getTestDataDir(relativeTestFilePath, testName), "crashes"),
          path.join(getTestDataDir(relativeTestFilePath, testName), "timeouts"),
        ];

  /** List crash/timeout artifact filenames across the artifact directories. */
  function listCrashArtifacts(): string[] {
    return artifactDirs.flatMap((dir) => {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter(
        (f) => f.startsWith("crash-") || f.startsWith("timeout-"),
      );
    });
  }

  const preExistingCrashes = new Set(listCrashArtifacts());

  let respawnCount = 0;
  // Consecutive respawns that recovered no input. A child that fails at startup
  // (or is killed externally) before the fuzz loop stashes anything trips this
  // breaker, so we bail with a diagnostic instead of storming to MAX_RESPAWNS.
  let consecutiveEmptyRespawns = 0;

  /**
   * Recover the crashing input + write its artifact, then decide what to do:
   * respawn (return null) or terminate with a SupervisorResult. Maintains the
   * startup-failure circuit breaker via `consecutiveEmptyRespawns`.
   */
  function respawnAfterRecovery(
    kind: ArtifactKind,
    identity: { signal?: string; exitCode?: number },
  ): SupervisorResult | null {
    const { crashArtifactPath, inputRecovered } = recoverInput(
      shmem,
      relativeTestFilePath,
      testName,
      kind,
      artifactPrefix,
    );

    if (inputRecovered) {
      consecutiveEmptyRespawns = 0;
    } else {
      consecutiveEmptyRespawns++;
    }

    // A run of crashes that never stash an input means the child is failing
    // before the fuzz loop reaches its first stash (instrumentation, module
    // load, or vitest setup) or is being killed externally. Diagnose that ahead
    // of the generic respawn limit - it is the more actionable outcome.
    if (consecutiveEmptyRespawns >= MAX_STARTUP_FAILURES) {
      process.stderr.write(
        `vitiate: child crashed ${consecutiveEmptyRespawns} times in a row ` +
          `without producing any recoverable input. This usually means it is ` +
          `failing at startup (module load, native addon init, or vitest ` +
          `setup) before the fuzz loop runs, or is being killed externally. ` +
          `Treating as an infrastructure failure, not a target crash.\n`,
      );
      // Spread identity first so the explicit result fields always win.
      return { ...identity, crashed: false, startupFailure: true };
    }

    // Stop once maxRespawns child generations have run (the initial spawn plus
    // maxRespawns-1 respawns); `respawnCount` counts respawns done so far.
    if (respawnCount + 1 >= maxRespawns) {
      process.stderr.write(
        `vitiate: respawn limit (${maxRespawns}) exceeded, giving up\n`,
      );
      return {
        ...identity,
        crashed: true,
        crashArtifactPath,
        timedOut: kind === "timeout",
      };
    }

    respawnCount++;
    process.stderr.write("vitiate: respawning child to continue fuzzing\n");
    return null;
  }

  /**
   * Handle a SIGKILL (exit code 137): preserve any in-flight input in the
   * segregated `ooms/` bucket and surface an infrastructure failure WITHOUT
   * respawning. SIGKILL is uncatchable and almost always external (OOM-killer,
   * memory limit, eviction, CI timeout), so it is never a confirmed crash.
   */
  function handleOomKill(identity: {
    signal?: string;
    exitCode?: number;
  }): SupervisorResult {
    process.stderr.write(
      `vitiate: child killed by SIGKILL (exit code ${SIGKILL_EXIT_CODE}). This ` +
        `is typically the OS OOM-killer, a container/cgroup memory limit, a ` +
        `k8s eviction, or a CI step timeout - not a confirmed crash in the ` +
        `target under test. vitiate does not respawn or record this as a crash.\n`,
    );
    const { crashArtifactPath } = recoverInput(
      shmem,
      relativeTestFilePath,
      testName,
      "oom",
      artifactPrefix,
    );
    if (crashArtifactPath !== undefined) {
      process.stderr.write(
        `vitiate: the in-flight input was preserved at ${crashArtifactPath} ` +
          `in case this was a memory-exhaustion input; investigate before ` +
          `treating it as a crash.\n`,
      );
    }
    // Spread identity first so the explicit result fields always win.
    return { ...identity, crashed: false, oomKilled: true, crashArtifactPath };
  }

  try {
    while (true) {
      const child = spawnChild();
      currentChild = child;

      const { code, signal } = await waitForChild(child);
      currentChild = null;

      if (signal !== null) {
        // Check for crash signals BEFORE checking user-initiated shutdown.
        // This prevents a concurrent SIGINT from swallowing a real crash.
        if (CRASH_SIGNALS.has(signal)) {
          process.stderr.write(`vitiate: child killed by signal ${signal}\n`);
          const outcome = respawnAfterRecovery("crash", { signal });
          if (outcome !== null) return outcome;
          continue;
        }

        // User-initiated shutdown: a child dying after we were asked to stop is
        // teardown collateral, not a finding. This intentionally comes before
        // the SIGKILL/OOM check below so a SIGKILL delivered to the whole
        // process group during Ctrl-C is not misreported as an OOM (mirrors the
        // exit-code path, which checks these flags before code 137).
        if (sigintReceived) {
          return { crashed: false, exitCode: code ?? 130 };
        }
        if (sigtermReceived) {
          return { crashed: false, exitCode: code ?? 143 };
        }

        // SIGKILL outside of shutdown is an uncatchable, almost-always-external
        // kill (OOM-killer, memory limit, eviction, CI timeout) - surface as an
        // infrastructure failure, not a crash. (Node usually also reports this
        // as exit code SIGKILL_EXIT_CODE; that form is handled below.)
        if (signal === "SIGKILL") {
          return handleOomKill({ signal });
        }

        // Other signal - treat as crash
        process.stderr.write(`vitiate: child killed by signal ${signal}\n`);
        const outcome = respawnAfterRecovery("crash", { signal });
        if (outcome !== null) return outcome;
        continue;
      }

      // No signal - check shutdown flags for exit-code paths too
      if (sigintReceived) {
        return { crashed: false, exitCode: code ?? 130 };
      }
      if (sigtermReceived) {
        return { crashed: false, exitCode: code ?? 143 };
      }

      // Child exited with a code
      if (code === 0) {
        // Campaign complete - no crash found or limits reached
        return { crashed: false, exitCode: 0 };
      }

      if (code === 1) {
        // Check whether the child actually wrote new crash artifacts.
        // Exit code 1 without new artifacts typically means a vitest
        // infrastructure failure (worker timeout, module resolution, etc.).
        const newArtifacts = listCrashArtifacts().filter(
          (f) => !preExistingCrashes.has(f),
        );
        // A soft timeout (in-loop watchdog / async idle) also exits the child
        // with code 1, but writes a `timeout-*` artifact rather than `crash-*`.
        // When the only new artifacts are timeouts, classify the finding as a
        // timeout so the exit-code mapping can emit timeout_exitcode.
        const timedOut =
          newArtifacts.length > 0 &&
          newArtifacts.every((f) => f.startsWith("timeout-"));
        return {
          crashed: true,
          exitCode: 1,
          newCrashArtifacts: newArtifacts.length > 0,
          timedOut,
        };
      }

      if (code === WATCHDOG_EXIT_CODE) {
        // Watchdog timeout - attempt backup recovery from shmem
        process.stderr.write("vitiate: child exited with watchdog timeout\n");
        const outcome = respawnAfterRecovery("timeout", {
          exitCode: WATCHDOG_EXIT_CODE,
        });
        if (outcome !== null) return outcome;
        continue;
      }

      if (code === ENGINE_PANIC_EXIT_CODE) {
        // The engine's panic hook intercepted a Rust panic and exited with a
        // dedicated code. This is a bug in vitiate itself, not a crash in the
        // target under test - do NOT fabricate a crash artifact or respawn
        // (which would just panic again and burn the respawn budget).
        process.stderr.write(
          `vitiate: child exited due to an internal engine panic ` +
            `(exit code ${code}); this is a vitiate bug, not a crash in the ` +
            `target under test. See the panic message above. No crash ` +
            `artifact written.\n`,
        );
        return { crashed: false, engineError: true, exitCode: code };
      }

      if (code === SIGKILL_EXIT_CODE) {
        // SIGKILL surfaced as an exit code (the usual case on Node). Treat as
        // an infrastructure kill (OOM / memory limit / eviction / CI timeout),
        // not a confirmed target crash.
        return handleOomKill({ exitCode: SIGKILL_EXIT_CODE });
      }

      // Exit codes that indicate crashes (e.g., SIGABRT as exit code)
      if (code !== null && CRASH_EXIT_CODES.has(code)) {
        process.stderr.write(
          `vitiate: child exited with crash exit code ${code}\n`,
        );
        const outcome = respawnAfterRecovery("crash", { exitCode: code });
        if (outcome !== null) return outcome;
        continue;
      }

      // Unknown exit code - treat as crash to avoid silently passing, and
      // attempt shmem input recovery like the known-crash paths (e.g. 139 =
      // SIGSEGV surfaced as an exit code under some container/PID-1 setups).
      // A child that repeatedly dies this way without stashing an input trips
      // the startup-failure circuit breaker instead of looping forever.
      process.stderr.write(
        `vitiate: child exited with unexpected exit code ${code}\n`,
      );
      const outcome = respawnAfterRecovery("crash", { exitCode: code ?? 1 });
      if (outcome !== null) return outcome;
      continue;
    }
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
  }
}

/**
 * Recover the in-flight input from shmem and, if one was stashed, write it as an
 * artifact of the given kind. Always resets the generation counter afterwards so
 * the next child starts from a clean slate.
 *
 * Uses the generation-aware `readConsistent` rather than `readStashedInput` so a
 * genuine empty (zero-length) input crash is still preserved as a 0-byte
 * artifact. `inputRecovered` is false only when nothing was stashed this run
 * (generation 0 - the child died before the fuzz loop reached its first stash)
 * or the write was torn; the supervisor uses that signal to detect a child that
 * is crashing at startup.
 */
function recoverInput(
  shmem: ShmemHandle,
  relativeTestFilePath: string,
  testName: string,
  kind: ArtifactKind,
  artifactPrefix?: string,
): { crashArtifactPath: string | undefined; inputRecovered: boolean } {
  let crashArtifactPath: string | undefined;
  const input = shmem.readConsistent();
  if (input !== null) {
    crashArtifactPath =
      artifactPrefix !== undefined
        ? writeArtifactWithPrefix(artifactPrefix, input, kind)
        : writeArtifact(relativeTestFilePath, testName, input, kind);
    process.stderr.write(
      `vitiate: ${kind} artifact written to ${crashArtifactPath}\n`,
    );
  }
  shmem.resetGeneration();
  return { crashArtifactPath, inputRecovered: input !== null };
}
