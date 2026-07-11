// Internal e2e fixture (not a demonstration target): proves the supervisor
// recovers an ABSORBED abrupt worker death via the shmem stash. Consumed by
// `vitiate-core/test/e2e-supervisor-recovery.test.ts`.
//
// It is inert unless E2E_ABRUPT_CRASH_MARKER points at a (non-existent) marker
// path, so it never crashes in the example's own `pnpm test` run or in the
// probabilistic e2e-fuzz pipeline (which pins a different include list). The
// name deliberately omits the VITIATE_ prefix so the CLI's env-var whitelist
// does not warn about it.
//
// The marker file makes the abrupt crash a genuine one-shot across respawned
// child processes: generation 0 dies abruptly (uncatchable SIGSEGV, so the
// fuzz loop's finally never runs and the pre-execution shmem stash survives -
// the supervisor's death certificate), and the respawned generation 1 re-finds
// the same seeded input in-band. That lets the campaign terminate at the
// natural crash exit code after a single respawn instead of storming to
// MAX_RESPAWNS.
import { fuzz } from "@vitiate/core";
import { existsSync, writeFileSync } from "node:fs";

const marker = process.env["E2E_ABRUPT_CRASH_MARKER"];
const SENTINEL = "BOOM";

fuzz("abrupt-crash", (data: Buffer) => {
  if (marker === undefined) return;
  if (data.length < SENTINEL.length) return;
  if (data.subarray(0, SENTINEL.length).toString() !== SENTINEL) return;

  if (!existsSync(marker)) {
    // Generation 0: mark first (so the respawn takes the in-band branch even
    // though this write races the imminent signal), then die abruptly. SIGSEGV
    // is not catchable in JS, so the loop's finally - which clears the stash -
    // never runs, and the in-flight input survives in shmem for recovery.
    writeFileSync(marker, "1");
    process.kill(process.pid, "SIGSEGV");
  }

  // Generation 1 (post-respawn): surface the same input in-band so the child
  // writes the crash artifact itself and the campaign exits with the crash
  // exit code.
  throw new Error("planted crash: abrupt-then-inband e2e fixture");
});
