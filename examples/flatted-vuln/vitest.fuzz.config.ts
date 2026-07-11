// Fuzz-mode config for the flatted-vuln example. This file is not wired into
// the example's package.json scripts; it doubles as an e2e fixture consumed by
// vitiate-core (see `vitiate-core/test/e2e-detectors.test.ts`, the "flatted
// prototype pollution" suite), which runs it with VITIATE_FUZZ=1.
import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      instrument: {
        // `packages` auto-instruments the dependency and configures Vitest
        // module inlining + transform-filter bypass; no manual server.deps
        // wiring needed.
        packages: ["flatted"],
      },
      fuzz: {
        fuzzTimeMs: 300_000,
        stopOnCrash: true,
        detectors: {
          prototypePollution: true,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.fuzz.ts"],
  },
});
