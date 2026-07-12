/**
 * E2E test that verifies instrumented code produces edge coverage.
 * Runs under vitest.instrumented.config.ts which applies vitiate's SWC plugin.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { parseCommand } from "./parser-target.js";
import { getDataDir } from "../src/config.js";

describe("e2e: plugin config propagates to the worker process", () => {
  // These assertions run in a forks-pool worker where no plugin hook executes;
  // the only channel for the resolved coverageMapSize/dataDir is the env vars
  // exported by the config hook in the main process. Before that propagation
  // existed, the worker allocated the default 65536-slot map (dropping most
  // edges) and derived the data dir from cwd.
  it("worker coverage map length matches the configured coverageMapSize", () => {
    expect(globalThis.__vitiate_cov.length).toBe(131072);
    expect(process.env["VITIATE_COVERAGE_MAP_SIZE"]).toBe("131072");
  });

  it("worker resolves the plugin-configured dataDir", () => {
    const root = process.env["VITIATE_PROJECT_ROOT"];
    expect(root).toBeTruthy();
    expect(getDataDir()).toBe(path.resolve(root!, ".vitiate-e2e-data"));
  });
});

describe("e2e: instrumented code produces edge coverage", () => {
  it("parseCommand increments coverage map entries", () => {
    const covMap = globalThis.__vitiate_cov;
    expect(covMap).toBeDefined();
    expect(covMap.length).toBeGreaterThan(0);

    // Snapshot the coverage map before calling the target
    const before = new Uint8Array(covMap.length);
    for (let i = 0; i < covMap.length; i++) {
      before[i] = covMap[i]!;
    }

    // Call the instrumented target
    parseCommand(Buffer.from("hello"));

    // Count how many coverage entries changed
    let edgeCount = 0;
    for (let i = 0; i < covMap.length; i++) {
      if (covMap[i] !== before[i]) edgeCount++;
    }

    expect(edgeCount).toBeGreaterThan(0);
  });

  it("different inputs hit different coverage entries", () => {
    const covMap = globalThis.__vitiate_cov;

    // Zero the map
    for (let i = 0; i < covMap.length; i++) {
      covMap[i] = 0;
    }

    // Call with input that takes the "get" path
    parseCommand(Buffer.from("GET"));
    const getEdges = new Set<number>();
    for (let i = 0; i < covMap.length; i++) {
      if (covMap[i]! > 0) getEdges.add(i);
    }

    // Zero the map again
    for (let i = 0; i < covMap.length; i++) {
      covMap[i] = 0;
    }

    // Call with input that takes the "set" path
    parseCommand(Buffer.from("S"));
    const setEdges = new Set<number>();
    for (let i = 0; i < covMap.length; i++) {
      if (covMap[i]! > 0) setEdges.add(i);
    }

    expect(getEdges.size).toBeGreaterThan(0);
    expect(setEdges.size).toBeGreaterThan(0);

    // The two paths should have some different edges
    const onlyInGet = [...getEdges].filter((e) => !setEdges.has(e));
    const onlyInSet = [...setEdges].filter((e) => !getEdges.has(e));
    expect(onlyInGet.length + onlyInSet.length).toBeGreaterThan(0);
  });
});
