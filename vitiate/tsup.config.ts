import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    globals: "src/globals.ts",
    setup: "src/setup.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node18",
  external: [
    "vitest",
    "vite",
    "vitest/node",
    "vitiate-napi",
    "vitiate-instrument",
    "@swc/core",
    "@optique/core",
    "@optique/run",
  ],
});
