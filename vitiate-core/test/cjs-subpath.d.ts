// node-forge has no exports map, so `node-forge/lib/asn1` resolves to a real
// file but @types/node-forge does not declare the subpath. Declare the minimal
// surface the subpath-instrumentation e2e uses.
declare module "node-forge/lib/asn1" {
  const asn1: { fromDer: (bytes: unknown) => unknown };
  export default asn1;
}

// Generated multi-file CJS fixture (written into node_modules by
// vitest.cjs-fixture.config.ts) driven by test/e2e-cjs-fixture.test.ts.
declare module "vitiate-cjs-fixture" {
  const mod: {
    runCommand: (command: string) => unknown;
    crash: (input: string) => unknown;
    named: number;
  };
  export default mod;
}
