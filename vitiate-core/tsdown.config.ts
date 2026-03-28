import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    plugin: "src/plugin.ts",
    setup: "src/setup.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  hash: false,
  target: "node18",
  deps: {
    neverBundle: [
      "vitest",
      "vite",
      "vitest/node",
      "@vitiate/engine",
      "@vitiate/swc-plugin",
      "@swc/core",
      "@optique/core",
      "@optique/run",
    ],
  },
});
