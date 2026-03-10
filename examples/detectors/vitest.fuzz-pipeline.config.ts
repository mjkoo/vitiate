import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      fuzz: {
        fuzzTimeMs: 10_000,
        stopOnCrash: true,
      },
    }),
  ],
  test: {
    include: ["test/detectors.fuzz.ts"],
    testNamePattern: "^detect-vulnerabilities$",
  },
});
