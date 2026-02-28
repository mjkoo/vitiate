import { describe, it, expect } from "vitest";
import { vitiatePlugin } from "./plugin.js";

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

  it("has a config function that adds setupFiles", () => {
    const plugin = vitiatePlugin();
    expect(typeof plugin.config).toBe("function");
    // Call config to verify it returns test.setupFiles
    const config = (plugin.config as () => Record<string, unknown>)();
    expect(config).toHaveProperty("test");
    const testConfig = config["test"] as Record<string, unknown>;
    expect(testConfig).toHaveProperty("setupFiles");
    const setupFiles = testConfig["setupFiles"] as string[];
    expect(setupFiles).toHaveLength(1);
    expect(setupFiles[0]).toContain("setup");
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
