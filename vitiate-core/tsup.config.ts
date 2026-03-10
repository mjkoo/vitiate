import { defineConfig } from "tsup";

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
  target: "node18",
  external: [
    "vitest",
    "vite",
    "vitest/node",
    "@vitiate/engine",
    "@vitiate/swc-plugin",
    "@swc/core",
    "@optique/core",
    "@optique/run",
  ],
});
