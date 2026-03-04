import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
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

  it("accepts the full options shape (fuzz + instrument)", () => {
    const plugin = vitiatePlugin({
      instrument: { include: ["src/**/*.ts"], exclude: [] },
      fuzz: { maxLen: 4096, timeoutMs: 5000, cacheDir: ".fuzz-cache" },
    });
    expect(plugin.name).toBe("vitiate");
    expect(plugin.enforce).toBe("post");
  });

  it("has a config function that adds setupFiles", () => {
    const savedRoot = process.env["VITIATE_PROJECT_ROOT"];
    try {
      delete process.env["VITIATE_PROJECT_ROOT"];
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
      if (savedRoot === undefined) {
        delete process.env["VITIATE_PROJECT_ROOT"];
      } else {
        process.env["VITIATE_PROJECT_ROOT"] = savedRoot;
      }
    }
  });

  describe("config hook env vars", () => {
    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = [
      "VITIATE_PROJECT_ROOT",
      "VITIATE_CACHE_DIR",
      "VITIATE_FUZZ_OPTIONS",
    ];

    afterEach(() => {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    function saveAndClearEnv(): void {
      for (const key of envKeys) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }

    it("sets VITIATE_PROJECT_ROOT from Vite config root", () => {
      saveAndClearEnv();
      const plugin = vitiatePlugin();
      callConfig(plugin, { root: "/my/project" });
      expect(process.env["VITIATE_PROJECT_ROOT"]).toBe(
        path.resolve("/my/project"),
      );
    });

    it("defaults project root to cwd when config.root is not set", () => {
      saveAndClearEnv();
      const plugin = vitiatePlugin();
      callConfig(plugin, {});
      expect(process.env["VITIATE_PROJECT_ROOT"]).toBe(process.cwd());
    });

    it("does not overwrite VITIATE_PROJECT_ROOT when already set", () => {
      saveAndClearEnv();
      process.env["VITIATE_PROJECT_ROOT"] = "/existing/root";
      const plugin = vitiatePlugin();
      callConfig(plugin, { root: "/other/root" });
      expect(process.env["VITIATE_PROJECT_ROOT"]).toBe("/existing/root");
    });

    it("sets VITIATE_CACHE_DIR resolved relative to project root", () => {
      saveAndClearEnv();
      const plugin = vitiatePlugin({ fuzz: { cacheDir: ".fuzz-cache" } });
      callConfig(plugin, { root: "/my/project" });
      expect(process.env["VITIATE_CACHE_DIR"]).toBe(
        path.resolve("/my/project", ".fuzz-cache"),
      );
    });

    it("resolves cacheDir against pre-set VITIATE_PROJECT_ROOT, not Vite root", () => {
      saveAndClearEnv();
      process.env["VITIATE_PROJECT_ROOT"] = "/custom/root";
      const plugin = vitiatePlugin({ fuzz: { cacheDir: ".cache" } });
      callConfig(plugin, { root: "/vite/root" });
      expect(process.env["VITIATE_PROJECT_ROOT"]).toBe("/custom/root");
      expect(process.env["VITIATE_CACHE_DIR"]).toBe(
        path.resolve("/custom/root", ".cache"),
      );
    });

    it("does not overwrite VITIATE_CACHE_DIR when already set", () => {
      saveAndClearEnv();
      process.env["VITIATE_CACHE_DIR"] = "/existing/cache";
      const plugin = vitiatePlugin({ fuzz: { cacheDir: ".fuzz-cache" } });
      callConfig(plugin, { root: "/my/project" });
      expect(process.env["VITIATE_CACHE_DIR"]).toBe("/existing/cache");
    });

    it("sets VITIATE_FUZZ_OPTIONS when fuzz options are provided", () => {
      saveAndClearEnv();
      const plugin = vitiatePlugin({
        fuzz: { maxLen: 4096, timeoutMs: 5000 },
      });
      callConfig(plugin, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBe(
        '{"maxLen":4096,"timeoutMs":5000}',
      );
    });

    it("does not overwrite VITIATE_FUZZ_OPTIONS when already set", () => {
      saveAndClearEnv();
      process.env["VITIATE_FUZZ_OPTIONS"] = '{"maxLen":1024}';
      const plugin = vitiatePlugin({
        fuzz: { maxLen: 4096 },
      });
      callConfig(plugin, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBe('{"maxLen":1024}');
    });

    it("does not set VITIATE_FUZZ_OPTIONS when only cacheDir is provided", () => {
      saveAndClearEnv();
      const plugin = vitiatePlugin({ fuzz: { cacheDir: ".cache" } });
      callConfig(plugin, {});
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBeUndefined();
    });

    it("does not set env vars when no fuzz options are provided", () => {
      saveAndClearEnv();
      const plugin = vitiatePlugin();
      callConfig(plugin, {});
      expect(process.env["VITIATE_CACHE_DIR"]).toBeUndefined();
      expect(process.env["VITIATE_FUZZ_OPTIONS"]).toBeUndefined();
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
