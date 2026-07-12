import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "../src/plugin.js";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      instrument: {
        include: ["**/parser-target.ts"],
      },
      // Non-default values so the worker-propagation assertions in
      // e2e-instrumented.test.ts are meaningful (they run in a forks-pool
      // worker where no plugin hook executes).
      coverageMapSize: 131072,
      dataDir: ".vitiate-e2e-data",
    }),
  ],
  test: {
    include: ["test/e2e-instrumented.test.ts"],
  },
});
