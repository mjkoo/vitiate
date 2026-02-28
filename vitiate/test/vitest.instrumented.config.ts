import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "../src/plugin.js";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      instrument: {
        include: ["**/parser-target.ts"],
      },
    }),
  ],
  test: {
    include: ["test/e2e-instrumented.test.ts"],
  },
});
