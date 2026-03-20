import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      instrument: {
        include: ["test/**", "**/flatted/**/*.js"],
        exclude: ["__noop__/node_modules"],
      },
      fuzz: {
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
