import path from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "es-module-lexer";
import type { Plugin } from "vite";
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import {
  getCoverageMapSize,
  resetCoverageMapSize,
  getProjectRoot,
  resetProjectRoot,
  getResolvedDataDir,
  resetDataDir,
} from "./config.js";
import { vitiatePlugin } from "./plugin.js";

/**
 * Extract the named plugin from the plugin array.
 */
function findPlugin(plugins: Plugin[], name: string): Plugin {
  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) throw new Error(`Plugin "${name}" not found`);
  return plugin;
}

function callConfig(
  plugin: Plugin,
  config: Record<string, unknown>,
): Record<string, unknown> {
  return (
    plugin.config as unknown as (
      config: Record<string, unknown>,
    ) => Record<string, unknown>
  )(config);
}

describe("plugin", () => {
  it("returns an array of two plugins", () => {
    const plugins = vitiatePlugin();
    expect(plugins).toHaveLength(2);
    expect(plugins[0]!.name).toBe("vitiate:hooks");
    expect(plugins[0]!.enforce).toBe("pre");
    expect(plugins[1]!.name).toBe("vitiate:instrument");
    expect(plugins[1]!.enforce).toBe("post");
  });

  it("instrument plugin has a transform function", () => {
    const plugins = vitiatePlugin();
    const instrument = findPlugin(plugins, "vitiate:instrument");
    expect(typeof instrument.transform).toBe("function");
  });

  it("accepts the full options shape (fuzz + instrument + coverageMapSize)", () => {
    const plugins = vitiatePlugin({
      instrument: { include: ["src/**/*.ts"], exclude: [] },
      fuzz: { maxLen: 4096, timeoutMs: 5000 },
      dataDir: ".fuzz-data",
      coverageMapSize: 131072,
    });
    expect(plugins).toHaveLength(2);
    expect(findPlugin(plugins, "vitiate:hooks").enforce).toBe("pre");
    expect(findPlugin(plugins, "vitiate:instrument").enforce).toBe("post");
  });

  it("has a config function that adds setupFiles", () => {
    resetProjectRoot();
    try {
      const plugins = vitiatePlugin();
      const instrument = findPlugin(plugins, "vitiate:instrument");
      expect(typeof instrument.config).toBe("function");
      const config = callConfig(instrument, {});
      expect(config).toHaveProperty("test");
      const testConfig = config["test"] as Record<string, unknown>;
      expect(testConfig).toHaveProperty("setupFiles");
      const setupFiles = testConfig["setupFiles"] as string[];
      expect(setupFiles).toHaveLength(1);
      expect(setupFiles[0]).toContain("setup");
    } finally {
      resetProjectRoot();
    }
  });

  describe("config hook", () => {
    const savedFuzzOptions = process.env["VITIATE_FUZZ_OPTIONS"];

    afterEach(() => {
      if (savedFuzzOptions === undefined) {
        delete process.env["VITIATE_FUZZ_OPTIONS"];
      } else {
        process.env["VITIATE_FUZZ_OPTIONS"] = savedFuzzOptions;
      }
      resetProjectRoot();
      resetDataDir();
      resetCoverageMapSize();
    });

    it("sets project root from Vite config root", () => {
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfig(instrument, { root: "/my/project" });
      expect(getProjectRoot()).toBe(path.resolve("/my/project"));
    });

    it("defaults project root to cwd when config.root is not set", () => {
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfig(instrument, {});
      expect(getProjectRoot()).toBe(process.cwd());
    });

    it("overwrites project root on each config() call", () => {
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfig(instrument, { root: "/first/root" });
      expect(getProjectRoot()).toBe(path.resolve("/first/root"));
      callConfig(instrument, { root: "/second/root" });
      expect(getProjectRoot()).toBe(path.resolve("/second/root"));
    });

    it("sets data dir resolved relative to project root", () => {
      const instrument = findPlugin(
        vitiatePlugin({ dataDir: ".fuzz-data" }),
        "vitiate:instrument",
      );
      callConfig(instrument, { root: "/my/project" });
      expect(getResolvedDataDir()).toBe(
        path.resolve("/my/project", ".fuzz-data"),
      );
    });

    it("resolves dataDir against Vite root", () => {
      const instrument = findPlugin(
        vitiatePlugin({ dataDir: ".data" }),
        "vitiate:instrument",
      );
      callConfig(instrument, { root: "/vite/root" });
      expect(getProjectRoot()).toBe(path.resolve("/vite/root"));
      expect(getResolvedDataDir()).toBe(path.resolve("/vite/root", ".data"));
    });

    it("does not set data dir when dataDir option is not provided", () => {
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfig(instrument, {});
      expect(getResolvedDataDir()).toBeUndefined();
    });

    it("sets VITIATE_FUZZ_OPTIONS when fuzz options are provided", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      const instrument = findPlugin(
        vitiatePlugin({ fuzz: { maxLen: 4096, timeoutMs: 5000 } }),
        "vitiate:instrument",
      );
      callConfig(instrument, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBe(
        '{"maxLen":4096,"timeoutMs":5000}',
      );
    });

    it("does not overwrite VITIATE_FUZZ_OPTIONS when already set", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = '{"maxLen":1024}';
      const instrument = findPlugin(
        vitiatePlugin({ fuzz: { maxLen: 4096 } }),
        "vitiate:instrument",
      );
      callConfig(instrument, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBe('{"maxLen":1024}');
    });

    it("serializes boolean fuzz options to VITIATE_FUZZ_OPTIONS", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      const instrument = findPlugin(
        vitiatePlugin({
          fuzz: { grimoire: true, unicode: false, redqueen: true },
        }),
        "vitiate:instrument",
      );
      callConfig(instrument, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBe(
        '{"grimoire":true,"unicode":false,"redqueen":true}',
      );
    });

    it("does not set VITIATE_FUZZ_OPTIONS when no fuzz options are provided but dataDir is", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      const instrument = findPlugin(
        vitiatePlugin({ dataDir: ".cache" }),
        "vitiate:instrument",
      );
      callConfig(instrument, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBeUndefined();
    });

    it("does not set VITIATE_FUZZ_OPTIONS when no fuzz options are provided", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfig(instrument, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBeUndefined();
    });

    it("sets coverage map size via setCoverageMapSize when coverageMapSize is provided", () => {
      const instrument = findPlugin(
        vitiatePlugin({ coverageMapSize: 131072 }),
        "vitiate:instrument",
      );
      callConfig(instrument, {});
      expect(getCoverageMapSize()).toBe(131072);
    });

    it("does not change coverage map size when coverageMapSize is not provided", () => {
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfig(instrument, {});
      expect(getCoverageMapSize()).toBe(65536);
    });

    it("throws when coverageMapSize is invalid", () => {
      const instrument = findPlugin(
        vitiatePlugin({ coverageMapSize: 100 }),
        "vitiate:instrument",
      );
      expect(() => callConfig(instrument, {})).toThrow(
        "coverageMapSize must be an integer in [256, 4194304]",
      );
    });

    it("returns test.server.deps.inline true when exclude is empty", () => {
      const instrument = findPlugin(
        vitiatePlugin({ instrument: { exclude: [] } }),
        "vitiate:instrument",
      );
      const config = callConfig(instrument, {});
      const testConfig = config["test"] as Record<string, unknown>;
      expect(testConfig).toHaveProperty("server");
      const server = testConfig["server"] as Record<string, unknown>;
      const deps = server["deps"] as Record<string, unknown>;
      expect(deps["inline"]).toBe(true);
    });

    it("does not set test.server.deps with default exclude", () => {
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      const config = callConfig(instrument, {});
      const testConfig = config["test"] as Record<string, unknown>;
      expect(testConfig).not.toHaveProperty("server");
    });

    it("does not set test.server.deps when exclude contains a narrower node_modules pattern", () => {
      const instrument = findPlugin(
        vitiatePlugin({
          instrument: { exclude: ["**/node_modules/lodash/**"] },
        }),
        "vitiate:instrument",
      );
      const config = callConfig(instrument, {});
      const testConfig = config["test"] as Record<string, unknown>;
      expect(testConfig).not.toHaveProperty("server");
    });
  });

  describe("hooks plugin transform", () => {
    beforeAll(async () => {
      // es-module-lexer requires WASM init before first parse
      await init;
    });

    function callHooksTransform(
      plugin: Plugin,
      code: string,
      id = "/project/src/app.ts",
    ): { code: string; map: unknown } | null {
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string; map: unknown } | null;
      return transform.call({ getCombinedSourcemap: () => null }, code, id);
    }

    function callInstrumentTransform(
      plugins: Plugin[],
      code: string,
      id: string,
    ): Promise<{ code: string; map?: string } | null> {
      const instrument = findPlugin(plugins, "vitiate:instrument");
      const transform = instrument.transform as (
        code: string,
        id: string,
      ) => Promise<{ code: string; map?: string } | null>;
      return transform.call({ getCombinedSourcemap: () => null }, code, id);
    }

    it("rewrites single-line named imports", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { execSync } from "child_process";',
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_child_process from "child_process";',
      );
      expect(result!.code).toContain(
        "const { execSync } = __vitiate_child_process;",
      );
    });

    it("rewrites multi-line named imports", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const code = [
        "import {",
        "  execSync,",
        "  spawnSync",
        '} from "child_process";',
      ].join("\n");
      const result = callHooksTransform(hooks, code);
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_child_process from "child_process";',
      );
      expect(result!.code).toContain(
        "const { execSync, spawnSync } = __vitiate_child_process;",
      );
    });

    it("rewrites default + named imports preserving the default name", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import cp, { execSync } from "child_process";',
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain('import cp from "child_process";');
      expect(result!.code).toContain("const { execSync } = cp;");
    });

    it("rewrites namespace imports", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import * as cp from "child_process";',
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_child_process from "child_process";',
      );
      expect(result!.code).toContain("const cp = __vitiate_child_process;");
    });

    it("rewrites aliased named imports", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { execSync as exec } from "child_process";',
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_child_process from "child_process";',
      );
      expect(result!.code).toContain(
        "const { execSync: exec } = __vitiate_child_process;",
      );
    });

    it("rewrites multiple aliased named imports", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { execSync as exec, spawnSync as spawn } from "child_process";',
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_child_process from "child_process";',
      );
      expect(result!.code).toContain(
        "const { execSync: exec, spawnSync: spawn } = __vitiate_child_process;",
      );
    });

    it("strips inline type specifiers from named imports", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { type ChildProcess, execSync } from "child_process";',
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_child_process from "child_process";',
      );
      expect(result!.code).toContain(
        "const { execSync } = __vitiate_child_process;",
      );
      expect(result!.code).not.toContain("ChildProcess");
    });

    it("skips type-only named imports (no value specifiers)", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { type ChildProcess, type ExecException } from "child_process";',
      );
      expect(result).toBeNull();
    });

    it("does not rewrite default-only imports", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import cp from "child_process";',
      );
      expect(result).toBeNull();
    });

    it("recognizes node: prefixed specifiers", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { readFileSync } from "node:fs";',
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain('import __vitiate_fs from "node:fs";');
      expect(result!.code).toContain("const { readFileSync } = __vitiate_fs;");
    });

    it("skips type-only imports", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import type { ChildProcess } from "child_process";',
      );
      expect(result).toBeNull();
    });

    it("skips non-hooked modules", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(hooks, 'import { join } from "path";');
      expect(result).toBeNull();
    });

    it("returns a source map with valid mappings", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { execSync } from "child_process";',
      );
      expect(result).not.toBeNull();
      expect(result!.map).toBeDefined();
      const map = result!.map as { mappings: string };
      expect(typeof map.mappings).toBe("string");
      expect(map.mappings.length).toBeGreaterThan(0);
    });

    it("rewrites multiple hooked imports in the same file", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const code = [
        'import { execSync } from "child_process";',
        'import { readFileSync } from "node:fs";',
        "const x = 1;",
      ].join("\n");
      const result = callHooksTransform(hooks, code);
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_child_process from "child_process";',
      );
      expect(result!.code).toContain(
        "const { execSync } = __vitiate_child_process;",
      );
      expect(result!.code).toContain('import __vitiate_fs from "node:fs";');
      expect(result!.code).toContain("const { readFileSync } = __vitiate_fs;");
    });

    it("rewrites fs/promises named imports", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { readFile } from "fs/promises";',
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_fs_promises from "fs/promises";',
      );
      expect(result!.code).toContain(
        "const { readFile } = __vitiate_fs_promises;",
      );
    });

    it("rewrites node:fs/promises named imports", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { readFile } from "node:fs/promises";',
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_fs_promises from "node:fs/promises";',
      );
      expect(result!.code).toContain(
        "const { readFile } = __vitiate_fs_promises;",
      );
    });

    it("bail-out skips source with 'fs' only in identifiers", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        "const offset = 42;\nconst buffs = [];",
      );
      expect(result).toBeNull();
    });

    it("bail-out proceeds for source with import from 'fs'", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { readFileSync } from "fs";',
      );
      expect(result).not.toBeNull();
    });

    it("bail-out proceeds for source with fs/promises reference", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { readFile } from "fs/promises";',
      );
      expect(result).not.toBeNull();
    });

    it("does not touch dynamic imports", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const code = 'const cp = await import("child_process");';
      const result = callHooksTransform(hooks, code);
      expect(result).toBeNull();
    });

    it("skips node_modules files with default config", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { execSync } from "child_process";',
        "/project/node_modules/some-lib/index.js",
      );
      expect(result).toBeNull();
    });

    it("processes a node_modules file when exclude is empty", () => {
      const hooks = findPlugin(
        vitiatePlugin({ instrument: { exclude: [] } }),
        "vitiate:hooks",
      );
      const result = callHooksTransform(
        hooks,
        'import { execSync } from "child_process";',
        "/project/node_modules/some-lib/index.js",
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_child_process from "child_process";',
      );
      expect(result!.code).toContain(
        "const { execSync } = __vitiate_child_process;",
      );
    });

    it("excludes vitiate-core even when exclude is empty", async () => {
      const plugins = vitiatePlugin({ instrument: { exclude: [] } });
      const hooks = findPlugin(plugins, "vitiate:hooks");
      const vitiateCoreSrc = path.dirname(fileURLToPath(import.meta.url));
      const id = `${vitiateCoreSrc}/some-internal.ts`;
      const code = 'import { execSync } from "child_process";';
      expect(callHooksTransform(hooks, code, id)).toBeNull();
      expect(await callInstrumentTransform(plugins, code, id)).toBeNull();
    });

    it("excludes vitiate-engine even when exclude is empty", async () => {
      const plugins = vitiatePlugin({ instrument: { exclude: [] } });
      const hooks = findPlugin(plugins, "vitiate:hooks");
      const engineDir = path.dirname(
        require.resolve("@vitiate/engine/package.json"),
      );
      const id = `${engineDir}/src/index.ts`;
      const code = 'import { execSync } from "child_process";';
      expect(callHooksTransform(hooks, code, id)).toBeNull();
      expect(await callInstrumentTransform(plugins, code, id)).toBeNull();
    });

    it("excludes vitiate-swc-plugin even when exclude is empty", async () => {
      const plugins = vitiatePlugin({ instrument: { exclude: [] } });
      const hooks = findPlugin(plugins, "vitiate:hooks");
      const swcDir = path.dirname(
        require.resolve("@vitiate/swc-plugin/package.json"),
      );
      const id = `${swcDir}/index.js`;
      const code = 'import { execSync } from "child_process";';
      expect(callHooksTransform(hooks, code, id)).toBeNull();
      expect(await callInstrumentTransform(plugins, code, id)).toBeNull();
    });

    it("narrowing include does not prevent hooks plugin from rewriting imports outside include scope", async () => {
      const plugins = vitiatePlugin({
        instrument: { include: ["src/**/*.ts"] },
      });
      const hooks = findPlugin(plugins, "vitiate:hooks");
      // A test file outside the "src/**/*.ts" include scope should still
      // get its hooked imports rewritten by the hooks plugin.
      const result = callHooksTransform(
        hooks,
        'import { execSync } from "child_process";',
        "/project/tests/parser.test.ts",
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_child_process from "child_process";',
      );

      // The instrument plugin should NOT instrument the same file because
      // it falls outside the narrowed include scope.
      const instrumentResult = await callInstrumentTransform(
        plugins,
        'import { execSync } from "child_process";',
        "/project/tests/parser.test.ts",
      );
      expect(instrumentResult).toBeNull();
    });

    it("skips non-JS/TS files (CSS, JSON, SVG)", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      for (const ext of [".css", ".json", ".svg", ".html", ".wasm"]) {
        const result = callHooksTransform(
          hooks,
          'import { execSync } from "child_process";',
          `/project/src/file${ext}`,
        );
        expect(result).toBeNull();
      }
    });

    it("processes all JS/TS file extensions", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      for (const ext of [
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        ".mjs",
        ".mts",
        ".cjs",
        ".cts",
      ]) {
        const result = callHooksTransform(
          hooks,
          'import { execSync } from "child_process";',
          `/project/src/file${ext}`,
        );
        expect(result).not.toBeNull();
      }
    });

    it("handles Vite query strings in file IDs", () => {
      const hooks = findPlugin(vitiatePlugin(), "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { execSync } from "child_process";',
        "/project/src/app.ts?v=abc123",
      );
      expect(result).not.toBeNull();
    });
  });

  describe("transform", () => {
    it("instruments a simple JS file", async () => {
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      const transform = instrument.transform as (
        code: string,
        id: string,
      ) => Promise<{ code: string; map?: string } | null>;

      const code = `
function add(a, b) {
  if (a === b) return a + a;
  return a + b;
}
`;
      const result = await transform.call(
        { getCombinedSourcemap: () => null },
        code,
        "/project/src/add.js",
      );

      expect(result).not.toBeNull();
      expect(result!.code).toContain("__vitiate_cov[");
      expect(result!.code).toContain("__vitiate_cmplog_write(");

      expect(result!.map).toBeDefined();
      const map = JSON.parse(result!.map as string) as Record<string, unknown>;
      expect(map).toHaveProperty("mappings");
      expect(typeof map["mappings"]).toBe("string");
      expect((map["mappings"] as string).length).toBeGreaterThan(0);
    });

    it("skips node_modules files by default", async () => {
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      const transform = instrument.transform as (
        code: string,
        id: string,
      ) => Promise<{ code: string; map?: string } | null>;

      const result = await transform.call(
        { getCombinedSourcemap: () => null },
        "export const x = 1;",
        "/project/node_modules/some-lib/index.js",
      );

      expect(result).toBeNull();
    });

    it("instruments node_modules files when exclude is empty", async () => {
      const instrument = findPlugin(
        vitiatePlugin({ instrument: { exclude: [] } }),
        "vitiate:instrument",
      );
      const transform = instrument.transform as (
        code: string,
        id: string,
      ) => Promise<{ code: string; map?: string } | null>;

      const code = `
function check(x) {
  if (x > 0) return true;
  return false;
}
`;
      const result = await transform.call(
        { getCombinedSourcemap: () => null },
        code,
        "/project/node_modules/some-lib/check.js",
      );

      expect(result).not.toBeNull();
      expect(result!.code).toContain("__vitiate_cov[");
    });
  });
});
