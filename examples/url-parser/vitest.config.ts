import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "vitiate/plugin";

export default defineConfig({
  plugins: [vitiatePlugin()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "fuzz",
          include: ["test/**/*.fuzz.ts"],
        },
      },
    ],
  },
});
