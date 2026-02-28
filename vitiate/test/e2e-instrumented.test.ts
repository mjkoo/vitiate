/**
 * E2E test that verifies instrumented code produces edge coverage.
 * Runs under vitest.instrumented.config.ts which applies vitiate's SWC plugin.
 */
import { describe, it, expect } from "vitest";
import { parseCommand } from "./parser-target.js";

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
