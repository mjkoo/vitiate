import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "@vitiate/core/plugin";

export default defineConfig({
  plugins: [vitiatePlugin()],
  test: {
    include: ["test/**/*.fuzz.ts"],
  },
});
