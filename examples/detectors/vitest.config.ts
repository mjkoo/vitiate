import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      fuzz: {
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
    include: ["test/**/*.fuzz.ts"],
  },
});
