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
