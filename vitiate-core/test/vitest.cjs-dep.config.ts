import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "../src/plugin.js";

// Instruments a pure-CommonJS multi-file dependency (node-forge) end to end
// through the real resolve/externalize path via the resolveId/load compilation
// hooks. Drives the e2e regression guard in test/e2e-cjs-dep.test.ts.
export default defineConfig({
  plugins: [
    vitiatePlugin({
      instrument: {
        packages: ["node-forge", "jpeg-js"],
      },
      coverageMapSize: 131072,
    }),
  ],
  test: {
    include: ["test/e2e-cjs-dep.test.ts"],
    pool: "forks",
  },
});
