import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e-fuzz.test.ts", "test/e2e-detectors.test.ts"],
  },
});
