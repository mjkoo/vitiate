import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [
      "test/e2e-instrumented.test.ts",
      "test/e2e-fuzz.test.ts",
      "test/e2e-detectors.test.ts",
      "test/e2e-supervisor-recovery.test.ts",
      "**/node_modules/**",
    ],
  },
});
