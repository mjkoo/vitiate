import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Watchdog } from "@vitiate/engine";
import { fuzz, replayCorpusEntry } from "./fuzz.js";
import { asWatchdogRunner, type WatchdogRunner } from "./loop.js";
import { getProjectRoot, setDataDir, resetDataDir } from "./config.js";
import { hashTestPath } from "./nix-base32.js";
import { VulnerabilityError } from "./detectors/types.js";

interface DetectorCall {
  method: "beforeIteration" | "endIteration";
  targetCompletedOk?: boolean;
  targetReturnValue?: unknown;
}

function makeDetectorSpy(): {
  calls: DetectorCall[];
  manager: Parameters<typeof replayCorpusEntry>[3];
} {
  const calls: DetectorCall[] = [];
  return {
    calls,
    manager: {
      beforeIteration: () => {
        calls.push({ method: "beforeIteration" });
      },
      endIteration: (
        targetCompletedOk: boolean,
        targetReturnValue?: unknown,
      ) => {
        calls.push({
          method: "endIteration",
          targetCompletedOk,
          targetReturnValue,
        });
        return undefined;
      },
    },
  };
}

describe("replayCorpusEntry with watchdog", () => {
  let tmpDir: string;
  let watchdog: Watchdog;

  beforeAll(() => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-replay-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    watchdog = new Watchdog(tmpDir + path.sep, null);
  });

  afterAll(() => {
    watchdog.shutdown();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("terminates a sync-blocking entry and attributes the timeout", async () => {
    const target = (data: Buffer): void => {
      if (data[0] === 0x42) {
        for (;;) {
          // Busy-loop until the watchdog terminates V8. The target cannot
          // return, so the timeout path is exercised deterministically.
        }
      }
    };
    await expect(
      replayCorpusEntry(
        target,
        Buffer.from([0x42]),
        "entry 3 (timeouts/timeout-abc)",
        undefined,
        asWatchdogRunner(watchdog),
        200,
      ),
    ).rejects.toThrow(/Corpus entry 3 .* timed out after 200ms/);
  });

  it("attributes a crashing entry", async () => {
    const target = (): void => {
      throw new Error("boom");
    };
    await expect(
      replayCorpusEntry(
        target,
        Buffer.from([0x01]),
        "entry 0 (crashes/crash-abc)",
        undefined,
        asWatchdogRunner(watchdog),
        200,
      ),
    ).rejects.toThrow(/Corpus entry 0 .* failed: boom/);
  });

  it("resolves a healthy entry after a prior timeout (no latched termination)", async () => {
    // Runs after the sync-block test above via sequential execution within
    // this file; a leaked V8 termination or armed deadline would fail here.
    let ran = false;
    const target = (): void => {
      ran = true;
    };
    await expect(
      replayCorpusEntry(
        target,
        Buffer.from([0x00]),
        "entry 1 (seeds/ok)",
        undefined,
        asWatchdogRunner(watchdog),
        200,
      ),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it("resolves a healthy async entry", async () => {
    const target = async (data: Buffer): Promise<void> => {
      await Promise.resolve(data);
    };
    await expect(
      replayCorpusEntry(
        target,
        Buffer.from([0x00]),
        "entry 2 (seeds/ok-async)",
        undefined,
        asWatchdogRunner(watchdog),
        200,
      ),
    ).resolves.toBeUndefined();
  });

  it("calls endIteration with ok=false on timeout so detector state resets", async () => {
    const spy = makeDetectorSpy();
    const target = (data: Buffer): void => {
      if (data[0] === 0x42) {
        for (;;) {
          // Busy-loop until watchdog termination.
        }
      }
    };
    await expect(
      replayCorpusEntry(
        target,
        Buffer.from([0x42]),
        "entry 0 (timeouts/timeout-x)",
        spy.manager,
        asWatchdogRunner(watchdog),
        200,
      ),
    ).rejects.toThrow(/timed out/);
    expect(spy.calls).toEqual([
      { method: "beforeIteration" },
      {
        method: "endIteration",
        targetCompletedOk: false,
        targetReturnValue: undefined,
      },
    ]);
  });

  it("wraps a detector finding on a timed-out entry with attribution", async () => {
    // A module-hook detector can stash a finding mid-execution before the
    // target hangs; endIteration(false) returns it. The thrown error must
    // carry the corpus label and the timeout fact, with the finding as cause.
    const finding = new VulnerabilityError("test-detector", "test-vuln", {
      probe: true,
    });
    const manager: Parameters<typeof replayCorpusEntry>[3] = {
      beforeIteration: () => undefined,
      endIteration: () => finding,
    };
    const target = (data: Buffer): void => {
      if (data[0] === 0x42) {
        for (;;) {
          // Busy-loop until watchdog termination.
        }
      }
    };
    const promise = replayCorpusEntry(
      target,
      Buffer.from([0x42]),
      "entry 7 (timeouts/timeout-y)",
      manager,
      asWatchdogRunner(watchdog),
      200,
    );
    await expect(promise).rejects.toThrow(
      /Corpus entry 7 .* failed: .*test-vuln.*timed out after 200ms/,
    );
    await promise.catch((e: unknown) => {
      expect((e as Error).cause).toBe(finding);
    });
  });

  it("balances the detector pair and attributes when executeTarget throws", async () => {
    // An engine-internal failure (NAPI marshaling / unexpected exitKind)
    // makes executeTarget throw rather than returning a Crash. beforeIteration
    // ran, so endIteration must still fire (restoring any snapshot) and the
    // error must be attributed to the corpus entry.
    const spy = makeDetectorSpy();
    const engineError = new Error("napi marshaling failed");
    const throwingRunner: WatchdogRunner = {
      runTarget: () => {
        throw engineError;
      },
      armWatchdog: () => undefined,
      disarmWatchdog: () => undefined,
      get didWatchdogFire() {
        return false;
      },
    };
    const promise = replayCorpusEntry(
      () => undefined,
      Buffer.from([0x01]),
      "entry 9 (crashes/crash-z)",
      spy.manager,
      throwingRunner,
      200,
    );
    await expect(promise).rejects.toThrow(
      /Corpus entry 9 .* failed: napi marshaling failed/,
    );
    await promise.catch((e: unknown) => {
      expect((e as Error).cause).toBe(engineError);
    });
    expect(spy.calls).toEqual([
      { method: "beforeIteration" },
      {
        method: "endIteration",
        targetCompletedOk: false,
        targetReturnValue: undefined,
      },
    ]);
  });
});

describe("replayCorpusEntry without watchdog (bare replay)", () => {
  it("attributes a crashing entry", async () => {
    const target = (): void => {
      throw new Error("bare boom");
    };
    await expect(
      replayCorpusEntry(
        target,
        Buffer.from([0x01]),
        "entry 0 (crashes/crash-abc)",
        undefined,
        null,
        undefined,
      ),
    ).rejects.toThrow(/Corpus entry 0 .* failed: bare boom/);
  });

  it("resolves a healthy entry", async () => {
    await expect(
      replayCorpusEntry(
        () => undefined,
        Buffer.alloc(0),
        "entry 0",
        undefined,
        null,
        undefined,
      ),
    ).resolves.toBeUndefined();
  });

  // NOTE: an async idle-await hang (never-resolving promise) is not
  // unit-testable in-process: without a watchdog nothing bounds it, and with
  // one it is caught only by the `_exit(77)` fallback, which would kill this
  // worker. Per repo testing rules we do not add a timing-based test for it.
});

// Registered end-to-end smoke: with timeoutMs set, the regression branch
// constructs a Watchdog, replays seeded entries under it, and shuts it down.
// fuzz() must be called at describe level (it delegates to vitest's test()).
describe("fuzz regression mode - watchdog-protected replay wiring", () => {
  const tmpDir = path.join(
    tmpdir(),
    `vitiate-replay-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  beforeAll(() => {
    const projectRoot = getProjectRoot();
    const thisFile = fileURLToPath(import.meta.url);
    const relativeFilePath = path.relative(projectRoot, thisFile);
    const hashDir = hashTestPath(
      relativeFilePath,
      "regression-watchdog-healthy",
    );
    const seedDir = path.join(tmpDir, "testdata", hashDir, "seeds");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(path.join(seedDir, "seed-hello"), "hello");
    setDataDir(tmpDir);
  });

  afterAll(() => {
    resetDataDir();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  fuzz(
    "regression-watchdog-healthy",
    (data) => {
      expect(data.length).toBeGreaterThan(0);
    },
    { timeoutMs: 500 },
  );
});
