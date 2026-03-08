import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "vitiate/plugin";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      fuzz: {
        fuzzTimeMs: 30_000,
        stopOnCrash: false,
      },
    }),
  ],
  test: {
    include: ["test/detectors.fuzz.ts"],
    testNamePattern: "^detect-vulnerabilities$",
  },
});
