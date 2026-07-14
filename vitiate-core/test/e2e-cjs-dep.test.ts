/**
 * E2E regression guard for CommonJS dependency instrumentation.
 *
 * node-forge and jpeg-js are pure-CommonJS multi-file packages. Before the
 * resolveId/load compilation path existed they were externalized past the SWC
 * transform and produced zero coverage (only the wrapper file was instrumented).
 * This test drives them through the real resolve/externalize path (not a
 * hardcoded module id) and asserts the coverage map grows well past wrapper-only
 * edges - proving the package's own multi-file sources are instrumented.
 */
import { describe, it, expect } from "vitest";
import forge from "node-forge";
import jpeg from "jpeg-js";
// Subpath import of a listed CommonJS package: node-forge has no exports map, so
// `node-forge/lib/asn1` resolves to a distinct entry file that resolveId
// compiles into its own bundle (keyed per entry).
import asn1 from "node-forge/lib/asn1";

/** Count coverage-map slots that changed between two snapshots. */
function countChangedEdges(before: Uint8Array, after: Uint8Array): number {
  let edges = 0;
  for (let i = 0; i < after.length; i++) {
    if (after[i] !== before[i]) edges++;
  }
  return edges;
}

function snapshot(): Uint8Array {
  const cov = globalThis.__vitiate_cov;
  return new Uint8Array(cov);
}

describe("e2e: CommonJS dependency instrumentation", () => {
  it("instruments node-forge's own multi-file sources (edges grow)", () => {
    const cov = globalThis.__vitiate_cov;
    expect(cov).toBeDefined();
    expect(cov.length).toBe(131072);

    const before = snapshot();
    // Drive node-forge's recursive ASN.1/DER decoder - deep multi-file logic.
    for (const input of ["", "hello", "\x30\x03\x02\x01\x05", "\x30\x82\x01"]) {
      try {
        const asn1 = forge.asn1.fromDer(forge.util.createBuffer(input));
        forge.pki.certificateFromAsn1(asn1);
      } catch {
        // Malformed inputs throw inside node-forge - that is the code we want
        // instrumented executing.
      }
    }
    const edges = countChangedEdges(before, snapshot());
    // Wrapper-only externalized runs produced <10 edges; real instrumentation
    // of node-forge's decoder produces many more.
    expect(edges).toBeGreaterThan(50);
  });

  it("binds node-forge named exports through the bundle", () => {
    // node-forge is consumed via default-export property access; assert the
    // interop surface the bundle exposes matches native usage.
    expect(typeof forge.pki).toBe("object");
    expect(typeof forge.asn1.fromDer).toBe("function");
  });

  it("instruments jpeg-js's decoder (edges grow)", () => {
    // Encode a small image, then decode it to drive jpeg-js's full multi-file
    // decoder (marker parsing, Huffman, IDCT) - deep instrumented logic.
    const width = 8;
    const height = 8;
    const data = Buffer.alloc(width * height * 4, 0x7f);
    const encoded = jpeg.encode({ data, width, height }, 50);

    const before = snapshot();
    jpeg.decode(encoded.data, { maxResolutionInMP: 1 });
    const edges = countChangedEdges(before, snapshot());
    expect(edges).toBeGreaterThan(50);
  });

  it("instruments a subpath entry (node-forge/lib/asn1) independently", () => {
    // The subpath entry is compiled lazily into its own bundle; driving it
    // produces instrumented coverage attributed to that subpath entry.
    expect(typeof asn1.fromDer).toBe("function");
    const before = snapshot();
    for (const input of ["", "\x30\x03\x02\x01\x05", "\x30\x82"]) {
      try {
        asn1.fromDer(forge.util.createBuffer(input));
      } catch {
        // Malformed DER throws inside the instrumented subpath entry.
      }
    }
    const edges = countChangedEdges(before, snapshot());
    expect(edges).toBeGreaterThan(20);
  });
});
