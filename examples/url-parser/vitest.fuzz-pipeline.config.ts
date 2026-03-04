import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "vitiate/plugin";

export default defineConfig({
  plugins: [
    vitiatePlugin({
      fuzz: {
        maxTotalTimeMs: 60_000,
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
