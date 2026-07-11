// Fuzz-mode config for the url-parser example. This file is not wired into the
// example's package.json scripts; it doubles as an e2e fixture consumed by
// vitiate-core (see `vitiate-core/test/e2e-fuzz.test.ts`), which runs it with
// VITIATE_FUZZ=1.
import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      fuzz: {
        fuzzTimeMs: 60_000,
        stopOnCrash: true,
      },
    }),
  ],
  test: {
    include: [
      "test/url-parser.fuzz.ts",
      "test/url-parser-async.fuzz.ts",
      "test/url-scheme.fuzz.ts",
    ],
    testNamePattern: "^(parse-url|parse-url-async|validate-scheme)$",
  },
});
