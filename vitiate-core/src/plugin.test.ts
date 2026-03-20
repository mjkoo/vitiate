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
  getConfigFile,
  resetConfigFile,
} from "./config.js";
import { vitiatePlugin, isListedPackage } from "./plugin.js";

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

function callConfigResolved(
  plugin: Plugin,
  resolvedConfig: Record<string, unknown>,
): void {
  (
    plugin.configResolved as unknown as (
      config: Record<string, unknown>,
    ) => void
  )(resolvedConfig);
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
    const savedFuzzOptions = process.env["VITIATE_OPTIONS"];

    afterEach(() => {
      if (savedFuzzOptions === undefined) {
        delete process.env["VITIATE_OPTIONS"];
      } else {
        process.env["VITIATE_OPTIONS"] = savedFuzzOptions;
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

    it("sets VITIATE_OPTIONS when fuzz options are provided", () => {
      delete process.env["VITIATE_OPTIONS"];
      const instrument = findPlugin(
        vitiatePlugin({ fuzz: { maxLen: 4096, timeoutMs: 5000 } }),
        "vitiate:instrument",
      );
      callConfig(instrument, {});
      expect(process.env["VITIATE_OPTIONS"]).toBe(
        '{"maxLen":4096,"timeoutMs":5000}',
      );
    });

    it("does not overwrite VITIATE_OPTIONS when already set", () => {
      process.env["VITIATE_OPTIONS"] = '{"maxLen":1024}';
      const instrument = findPlugin(
        vitiatePlugin({ fuzz: { maxLen: 4096 } }),
        "vitiate:instrument",
      );
      callConfig(instrument, {});
      expect(process.env["VITIATE_OPTIONS"]).toBe('{"maxLen":1024}');
    });

    it("serializes boolean fuzz options to VITIATE_OPTIONS", () => {
      delete process.env["VITIATE_OPTIONS"];
      const instrument = findPlugin(
        vitiatePlugin({
          fuzz: { grimoire: true, unicode: false, redqueen: true },
        }),
        "vitiate:instrument",
      );
      callConfig(instrument, {});
      expect(process.env["VITIATE_OPTIONS"]).toBe(
        '{"grimoire":true,"unicode":false,"redqueen":true}',
      );
    });

    it("does not set VITIATE_OPTIONS when no fuzz options are provided but dataDir is", () => {
      delete process.env["VITIATE_OPTIONS"];
      const instrument = findPlugin(
        vitiatePlugin({ dataDir: ".cache" }),
        "vitiate:instrument",
      );
      callConfig(instrument, {});
      expect(process.env["VITIATE_OPTIONS"]).toBeUndefined();
    });

    it("does not set VITIATE_OPTIONS when no fuzz options are provided", () => {
      delete process.env["VITIATE_OPTIONS"];
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfig(instrument, {});
      expect(process.env["VITIATE_OPTIONS"]).toBeUndefined();
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

    it("does not set test.server.deps.inline when exclude is empty and no packages", () => {
      const instrument = findPlugin(
        vitiatePlugin({ instrument: { exclude: [] } }),
        "vitiate:instrument",
      );
      const config = callConfig(instrument, {});
      const testConfig = config["test"] as Record<string, unknown>;
      expect(testConfig).not.toHaveProperty("server");
    });

    it("does not set test.server.deps with default config", () => {
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      const config = callConfig(instrument, {});
      const testConfig = config["test"] as Record<string, unknown>;
      expect(testConfig).not.toHaveProperty("server");
    });
  });

  describe("configResolved hook", () => {
    const savedFuzz = process.env["VITIATE_FUZZ"];
    const savedCov = globalThis.__vitiate_cov;
    const savedCmplog = globalThis.__vitiate_cmplog_write;
    const savedResetCounts = globalThis.__vitiate_cmplog_reset_counts;
    const savedCmplogImpl = globalThis.__vitiate_cmplog_write_impl;
    const savedResetCountsImpl = globalThis.__vitiate_cmplog_reset_counts_impl;

    afterEach(() => {
      if (savedFuzz === undefined) {
        delete process.env["VITIATE_FUZZ"];
      } else {
        process.env["VITIATE_FUZZ"] = savedFuzz;
      }
      resetConfigFile();
      globalThis.__vitiate_cov = savedCov;
      globalThis.__vitiate_cmplog_write = savedCmplog;
      globalThis.__vitiate_cmplog_reset_counts = savedResetCounts;
      globalThis.__vitiate_cmplog_write_impl = savedCmplogImpl;
      globalThis.__vitiate_cmplog_reset_counts_impl = savedResetCountsImpl;
    });

    it("captures config file path from resolvedConfig.configFile", () => {
      delete process.env["VITIATE_FUZZ"];
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfigResolved(instrument, {
        configFile: "/project/vitest.config.ts",
      });
      expect(getConfigFile()).toBe("/project/vitest.config.ts");
    });

    it("stores undefined when configFile is false (no config file)", () => {
      delete process.env["VITIATE_FUZZ"];
      resetConfigFile();
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfigResolved(instrument, { configFile: false });
      expect(getConfigFile()).toBeUndefined();
    });

    it("initializes __vitiate_cov as Uint8Array in regression mode", () => {
      delete process.env["VITIATE_FUZZ"];
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfigResolved(instrument, { configFile: false });
      expect(globalThis.__vitiate_cov).toBeInstanceOf(Uint8Array);
      expect(globalThis.__vitiate_cov.length).toBe(getCoverageMapSize());
    });

    it("initializes __vitiate_cov as Buffer in fuzz mode", () => {
      process.env["VITIATE_FUZZ"] = "1";
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfigResolved(instrument, { configFile: false });
      expect(globalThis.__vitiate_cov).toBeInstanceOf(Buffer);
      expect(globalThis.__vitiate_cov.length).toBe(getCoverageMapSize());
    });

    it("initializes __vitiate_cmplog_write as a forwarding wrapper", () => {
      delete process.env["VITIATE_FUZZ"];
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfigResolved(instrument, { configFile: false });
      expect(typeof globalThis.__vitiate_cmplog_write).toBe("function");
      // Should not throw - delegates to no-op impl
      expect(globalThis.__vitiate_cmplog_write("a", "b", 0, 0)).toBeUndefined();
    });

    it("initializes __vitiate_cmplog_reset_counts as a forwarding wrapper", () => {
      delete process.env["VITIATE_FUZZ"];
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfigResolved(instrument, { configFile: false });
      expect(typeof globalThis.__vitiate_cmplog_reset_counts).toBe("function");
      expect(globalThis.__vitiate_cmplog_reset_counts()).toBeUndefined();
    });

    it("cmplog wrapper delegates to swapped implementation", () => {
      delete process.env["VITIATE_FUZZ"];
      const instrument = findPlugin(vitiatePlugin(), "vitiate:instrument");
      callConfigResolved(instrument, { configFile: false });

      // Cache the wrapper reference (as a module would at module scope)
      const cachedWrite = globalThis.__vitiate_cmplog_write;
      const calls: unknown[][] = [];

      // Swap the implementation
      globalThis.__vitiate_cmplog_write_impl = (
        left: unknown,
        right: unknown,
        cmpId: number,
        opId: number,
      ) => {
        calls.push([left, right, cmpId, opId]);
      };

      // Call through the cached reference
      cachedWrite("hello", "world", 42, 1);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["hello", "world", 42, 1]);
    });
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

  describe("hooks plugin transform", () => {
    beforeAll(async () => {
      // es-module-lexer requires WASM init before first parse
      await init;
    });

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

    it("skips node_modules files even when user exclude is empty", () => {
      const hooks = findPlugin(
        vitiatePlugin({ instrument: { exclude: [] } }),
        "vitiate:hooks",
      );
      const result = callHooksTransform(
        hooks,
        'import { execSync } from "child_process";',
        "/project/node_modules/some-lib/index.js",
      );
      // node_modules is always excluded internally regardless of user exclude
      expect(result).toBeNull();
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

    it("skips node_modules files even when user exclude is empty", async () => {
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

      // node_modules always excluded from include/exclude filter
      expect(result).toBeNull();
    });

    it("exclude takes precedence over include", async () => {
      const instrument = findPlugin(
        vitiatePlugin({
          instrument: {
            include: ["**/*.js"],
            exclude: ["**/generated/**"],
          },
        }),
        "vitiate:instrument",
      );
      const transform = instrument.transform as (
        code: string,
        id: string,
      ) => Promise<{ code: string; map?: string } | null>;

      const code = "function f(x) { if (x > 0) return true; return false; }";

      // File in include scope but also in exclude scope - exclude wins
      const excluded = await transform.call(
        { getCombinedSourcemap: () => null },
        code,
        "/project/src/generated/parser.js",
      );
      expect(excluded).toBeNull();

      // File in include scope and not in exclude scope - instrumented
      const included = await transform.call(
        { getCombinedSourcemap: () => null },
        code,
        "/project/src/parser.js",
      );
      expect(included).not.toBeNull();
      expect(included!.code).toContain("__vitiate_cov[");
    });
  });

  describe("isListedPackage", () => {
    it("returns the matched package name for a standard node_modules path", () => {
      expect(
        isListedPackage("/project/node_modules/flatted/src/index.js", [
          "flatted",
        ]),
      ).toBe("flatted");
    });

    it("returns the matched package name for a pnpm nested layout path", () => {
      expect(
        isListedPackage(
          "/project/node_modules/.pnpm/flatted@3.4.1/node_modules/flatted/src/index.js",
          ["flatted"],
        ),
      ).toBe("flatted");
    });

    it("returns the matched package name for a nested node_modules path", () => {
      expect(
        isListedPackage(
          "/project/node_modules/foo/node_modules/flatted/src/index.js",
          ["flatted"],
        ),
      ).toBe("flatted");
    });

    it("rejects partial package name match", () => {
      expect(
        isListedPackage("/project/node_modules/flatted/src/index.js", ["flat"]),
      ).toBeUndefined();
    });

    it("returns the matched scoped package name", () => {
      expect(
        isListedPackage("/project/node_modules/@scope/pkg/src/index.js", [
          "@scope/pkg",
        ]),
      ).toBe("@scope/pkg");
    });

    it("rejects vitiate packages", () => {
      expect(
        isListedPackage("/project/node_modules/@vitiate/core/src/index.js", [
          "@vitiate/core",
        ]),
      ).toBeUndefined();
    });

    it("returns undefined for empty packages list", () => {
      expect(
        isListedPackage("/project/node_modules/flatted/src/index.js", []),
      ).toBeUndefined();
    });

    it("returns the first matched package name when multiple packages are listed", () => {
      const packages = ["flatted", "lodash"];
      expect(
        isListedPackage("/project/node_modules/flatted/src/index.js", packages),
      ).toBe("flatted");
      expect(
        isListedPackage("/project/node_modules/lodash/index.js", packages),
      ).toBe("lodash");
      expect(
        isListedPackage("/project/node_modules/other/index.js", packages),
      ).toBeUndefined();
    });
  });

  describe("packages option", () => {
    afterEach(() => {
      resetProjectRoot();
      resetConfigFile();
    });

    it("instruments listed package files via transform hook", async () => {
      const plugins = vitiatePlugin({
        instrument: { packages: ["flatted"] },
      });
      const instrument = findPlugin(plugins, "vitiate:instrument");
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
        "/project/node_modules/flatted/src/index.js",
      );

      expect(result).not.toBeNull();
      expect(result!.code).toContain("__vitiate_cov[");
    });

    it("does not instrument unlisted package files", async () => {
      const plugins = vitiatePlugin({
        instrument: { packages: ["flatted"] },
      });
      const instrument = findPlugin(plugins, "vitiate:instrument");
      const transform = instrument.transform as (
        code: string,
        id: string,
      ) => Promise<{ code: string; map?: string } | null>;

      const result = await transform.call(
        { getCombinedSourcemap: () => null },
        "export const x = 1;",
        "/project/node_modules/lodash/index.js",
      );

      expect(result).toBeNull();
    });

    it("config hook returns inline patterns for listed packages", () => {
      const plugins = vitiatePlugin({
        instrument: { packages: ["flatted"] },
      });
      const instrument = findPlugin(plugins, "vitiate:instrument");
      const config = callConfig(instrument, {});
      const testConfig = config["test"] as Record<string, unknown>;
      const server = testConfig["server"] as Record<string, unknown>;
      const deps = server["deps"] as Record<string, unknown>;
      const inline = deps["inline"] as RegExp[];
      expect(inline).toHaveLength(1);
      expect(inline[0]!.test("/node_modules/flatted/")).toBe(true);
      expect(inline[0]!.test("/node_modules/other/")).toBe(false);
    });

    it("config hook does not modify inline when packages is empty", () => {
      const plugins = vitiatePlugin({
        instrument: { packages: [] },
      });
      const instrument = findPlugin(plugins, "vitiate:instrument");
      const config = callConfig(instrument, {});
      const testConfig = config["test"] as Record<string, unknown>;
      expect(testConfig).not.toHaveProperty("server");
    });

    it("hooks plugin rewrites hooked imports in listed packages", () => {
      const plugins = vitiatePlugin({
        instrument: { packages: ["flatted"] },
      });
      const hooks = findPlugin(plugins, "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { execSync } from "child_process";',
        "/project/node_modules/flatted/src/index.js",
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        'import __vitiate_child_process from "child_process";',
      );
    });

    it("hooks plugin does not process unlisted packages", () => {
      const plugins = vitiatePlugin({
        instrument: { packages: ["flatted"] },
      });
      const hooks = findPlugin(plugins, "vitiate:hooks");
      const result = callHooksTransform(
        hooks,
        'import { execSync } from "child_process";',
        "/project/node_modules/lodash/index.js",
      );
      expect(result).toBeNull();
    });

    it("vitiate packages are rejected from packages list", () => {
      const plugins = vitiatePlugin({
        instrument: { packages: ["@vitiate/core"] },
      });
      const instrument = findPlugin(plugins, "vitiate:instrument");
      const config = callConfig(instrument, {});
      const testConfig = config["test"] as Record<string, unknown>;
      // No server config because vitiate packages are filtered out
      expect(testConfig).not.toHaveProperty("server");
    });

    it("buildEnd warns about listed packages that were never transformed", () => {
      const plugins = vitiatePlugin({
        instrument: { packages: ["not-installed-pkg"] },
      });
      const instrument = findPlugin(plugins, "vitiate:instrument");

      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        (instrument.buildEnd as () => void)();
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toContain("not-installed-pkg");
        expect(chunks[0]).toContain("instrument.packages");
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("buildEnd does not warn about packages that were transformed", async () => {
      const plugins = vitiatePlugin({
        instrument: { packages: ["flatted"] },
      });

      // Run a transform so the package is marked as seen
      await callInstrumentTransform(
        plugins,
        "function f(x) { return x; }",
        "/project/node_modules/flatted/src/index.js",
      );

      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        const instrument = findPlugin(plugins, "vitiate:instrument");
        (instrument.buildEnd as () => void)();
        expect(chunks).toHaveLength(0);
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });
});
