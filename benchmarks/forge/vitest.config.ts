import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

// node-forge is pure CommonJS, so its node_modules code is only instrumentable
// through `instrument.packages` (the CJS-compilation path). This benchmark has
// exactly one target, so only its package is listed - nothing is instrumented
// that the target does not use.
export default defineConfig({
  plugins: [
    vitiatePlugin({
      instrument: {
        packages: ["node-forge"],
      },
      fuzz: {
        maxLen: 8192,
        timeoutMs: 30000,
      },
      dataDir: ".vitiate",
    }),
  ],
  test: {
    include: ["fuzz/**/*.fuzz.ts"],
  },
});
