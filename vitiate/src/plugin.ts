/**
 * Vite plugin for vitiate instrumentation.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFilter, type Plugin } from "vite";
import type { VitiatePluginOptions } from "./config.js";
import { resolveInstrumentOptions, COVERAGE_MAP_SIZE } from "./config.js";

const require = createRequire(import.meta.url);

function resolveWasmPath(): string {
  const instrumentPkgPath = require.resolve("vitiate-instrument/package.json");
  const instrumentPkg = require(instrumentPkgPath) as { main?: string };
  if (!instrumentPkg.main) {
    throw new Error(
      "vitiate-instrument package.json is missing a 'main' field",
    );
  }
  const pkgDir = path.dirname(instrumentPkgPath);
  return path.join(pkgDir, instrumentPkg.main);
}

function resolveSetupPath(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  // In development (src/), the setup file is setup.ts
  // In production (dist/), the setup file is setup.js
  const tsPath = path.join(thisDir, "setup.ts");
  if (existsSync(tsPath)) return tsPath;
  const jsPath = path.join(thisDir, "setup.js");
  if (existsSync(jsPath)) return jsPath;
  throw new Error(`Cannot find setup file: tried ${tsPath} and ${jsPath}`);
}

export function vitiatePlugin(options?: VitiatePluginOptions): Plugin {
  const { include, exclude } = resolveInstrumentOptions(options?.instrument);
  const filter = createFilter(include, exclude);
  const wasmPath = resolveWasmPath();
  const setupPath = resolveSetupPath();

  return {
    name: "vitiate",
    enforce: "post",

    config() {
      return {
        test: {
          setupFiles: [setupPath],
        },
      };
    },

    async transform(code, id) {
      if (!filter(id)) return null;

      const { transform } = await import("@swc/core");
      const result = await transform(code, {
        filename: id,
        sourceMaps: true,
        jsc: {
          parser: { syntax: "ecmascript" },
          target: "es2022",
          experimental: {
            plugins: [
              [
                wasmPath,
                {
                  coverageMapSize: COVERAGE_MAP_SIZE,
                  traceCmp: true,
                  coverageGlobalName: "__vitiate_cov",
                  traceCmpGlobalName: "__vitiate_trace_cmp",
                },
              ],
            ],
          },
        },
        isModule: true,
      });

      return {
        code: result.code,
        map: result.map ?? undefined,
      };
    },
  };
}
