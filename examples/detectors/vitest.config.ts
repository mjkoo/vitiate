import { defineConfig } from "vitest/config";
import { vitiatePlugin } from "vitiate/plugin";

export default defineConfig({
  plugins: [vitiatePlugin()],
  test: {
    include: ["test/**/*.fuzz.ts"],
  },
});
