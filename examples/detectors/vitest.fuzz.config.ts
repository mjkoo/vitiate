// Fuzz-mode config for the detectors example. This file is not wired into the
// example's package.json scripts; it doubles as an e2e fixture consumed by
// vitiate-core (see `vitiate-core/test/e2e-detectors.test.ts`), which runs it
// with VITIATE_FUZZ=1.
import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      fuzz: {
        fuzzTimeMs: 10_000,
        stopOnCrash: true,
        detectors: {
          prototypePollution: true,
          redos: true,
          ssrf: true,
          unsafeEval: true,
        },
      },
    }),
  ],
  test: {
    include: ["test/detectors.fuzz.ts"],
    testNamePattern: "^detect-vulnerabilities$",
  },
});
