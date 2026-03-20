import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      instrument: {
        packages: ["flatted"],
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
  },
});
