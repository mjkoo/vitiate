import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      instrument: {
        include: ["test/**", "**/flatted/**/*.js"],
        // Dummy pattern: mentions "node_modules" so the plugin's heuristic
        // doesn't set inline:true for ALL deps, but matches nothing real.
        exclude: ["__noop__/node_modules"],
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
    server: {
      deps: {
        inline: [/flatted/],
      },
    },
  },
});
