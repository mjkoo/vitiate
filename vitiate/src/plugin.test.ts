import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  getCoverageMapSize,
  resetCoverageMapSize,
  getProjectRoot,
  resetProjectRoot,
  getResolvedCacheDir,
  resetCacheDir,
} from "./config.js";
import { vitiatePlugin } from "./plugin.js";

function callConfig(
  plugin: ReturnType<typeof vitiatePlugin>,
  config: Record<string, unknown>,
): Record<string, unknown> {
  return (
    plugin.config as unknown as (
      config: Record<string, unknown>,
    ) => Record<string, unknown>
  )(config);
}

describe("plugin", () => {
  it("returns a plugin with correct name and enforce", () => {
    const plugin = vitiatePlugin();
    expect(plugin.name).toBe("vitiate");
    expect(plugin.enforce).toBe("post");
  });

  it("has a transform function", () => {
    const plugin = vitiatePlugin();
    expect(typeof plugin.transform).toBe("function");
  });

  it("accepts the full options shape (fuzz + instrument + coverageMapSize)", () => {
    const plugin = vitiatePlugin({
      instrument: { include: ["src/**/*.ts"], exclude: [] },
      fuzz: { maxLen: 4096, timeoutMs: 5000 },
      cacheDir: ".fuzz-cache",
      coverageMapSize: 131072,
    });
    expect(plugin.name).toBe("vitiate");
    expect(plugin.enforce).toBe("post");
  });

  it("has a config function that adds setupFiles", () => {
    resetProjectRoot();
    try {
      const plugin = vitiatePlugin();
      expect(typeof plugin.config).toBe("function");
      // Call config to verify it returns test.setupFiles
      const config = callConfig(plugin, {});
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
      resetCacheDir();
      resetCoverageMapSize();
    });

    it("sets project root from Vite config root", () => {
      const plugin = vitiatePlugin();
      callConfig(plugin, { root: "/my/project" });
      expect(getProjectRoot()).toBe(path.resolve("/my/project"));
    });

    it("defaults project root to cwd when config.root is not set", () => {
      const plugin = vitiatePlugin();
      callConfig(plugin, {});
      expect(getProjectRoot()).toBe(process.cwd());
    });

    it("overwrites project root on each config() call", () => {
      const plugin = vitiatePlugin();
      callConfig(plugin, { root: "/first/root" });
      expect(getProjectRoot()).toBe(path.resolve("/first/root"));
      callConfig(plugin, { root: "/second/root" });
      expect(getProjectRoot()).toBe(path.resolve("/second/root"));
    });

    it("sets cache dir resolved relative to project root", () => {
      const plugin = vitiatePlugin({ cacheDir: ".fuzz-cache" });
      callConfig(plugin, { root: "/my/project" });
      expect(getResolvedCacheDir()).toBe(
        path.resolve("/my/project", ".fuzz-cache"),
      );
    });

    it("resolves cacheDir against Vite root", () => {
      const plugin = vitiatePlugin({ cacheDir: ".cache" });
      callConfig(plugin, { root: "/vite/root" });
      expect(getProjectRoot()).toBe(path.resolve("/vite/root"));
      expect(getResolvedCacheDir()).toBe(path.resolve("/vite/root", ".cache"));
    });

    it("does not set cache dir when cacheDir option is not provided", () => {
      const plugin = vitiatePlugin();
      callConfig(plugin, {});
      expect(getResolvedCacheDir()).toBeUndefined();
    });

    it("sets VITIATE_FUZZ_OPTIONS when fuzz options are provided", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      const plugin = vitiatePlugin({
        fuzz: { maxLen: 4096, timeoutMs: 5000 },
      });
      callConfig(plugin, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBe(
        '{"maxLen":4096,"timeoutMs":5000}',
      );
    });

    it("does not overwrite VITIATE_FUZZ_OPTIONS when already set", () => {
      process.env["VITIATE_FUZZ_OPTIONS"] = '{"maxLen":1024}';
      const plugin = vitiatePlugin({
        fuzz: { maxLen: 4096 },
      });
      callConfig(plugin, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBe('{"maxLen":1024}');
    });

    it("serializes boolean fuzz options to VITIATE_FUZZ_OPTIONS", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      const plugin = vitiatePlugin({
        fuzz: { grimoire: true, unicode: false, redqueen: true },
      });
      callConfig(plugin, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBe(
        '{"grimoire":true,"unicode":false,"redqueen":true}',
      );
    });

    it("does not set VITIATE_FUZZ_OPTIONS when no fuzz options are provided but cacheDir is", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      const plugin = vitiatePlugin({ cacheDir: ".cache" });
      callConfig(plugin, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBeUndefined();
    });

    it("does not set VITIATE_FUZZ_OPTIONS when no fuzz options are provided", () => {
      delete process.env["VITIATE_FUZZ_OPTIONS"];
      const plugin = vitiatePlugin();
      callConfig(plugin, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBeUndefined();
    });

    it("sets coverage map size via setCoverageMapSize when coverageMapSize is provided", () => {
      const plugin = vitiatePlugin({ coverageMapSize: 131072 });
      callConfig(plugin, {});
      expect(getCoverageMapSize()).toBe(131072);
    });

    it("does not change coverage map size when coverageMapSize is not provided", () => {
      const plugin = vitiatePlugin();
      callConfig(plugin, {});
      expect(getCoverageMapSize()).toBe(65536);
    });

    it("throws when coverageMapSize is invalid", () => {
      const plugin = vitiatePlugin({ coverageMapSize: 100 });
      expect(() => callConfig(plugin, {})).toThrow(
        "coverageMapSize must be an integer in [256, 4194304]",
      );
    });
  });

  describe("transform", () => {
    it("instruments a simple JS file", async () => {
      const plugin = vitiatePlugin();
      const transform = plugin.transform as (
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
      expect(result!.code).toContain("__vitiate_trace_cmp(");

      // Fix 4: source maps should be present
      expect(result!.map).toBeDefined();
      const map = JSON.parse(result!.map as string) as Record<string, unknown>;
      expect(map).toHaveProperty("mappings");
      expect(typeof map["mappings"]).toBe("string");
      expect((map["mappings"] as string).length).toBeGreaterThan(0);
    });

    it("skips node_modules files by default", async () => {
      const plugin = vitiatePlugin();
      const transform = plugin.transform as (
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
      const plugin = vitiatePlugin({ instrument: { exclude: [] } });
      const transform = plugin.transform as (
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
