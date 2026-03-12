// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightThemeRapide from "starlight-theme-rapide";

// https://astro.build/config
export default defineConfig({
  site: "https://mjkoo.github.io",
  base: "/vitiate",
  integrations: [
    starlight({
      plugins: [starlightThemeRapide()],
      title: "Vitiate",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/mjkoo/vitiate",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Quickstart", slug: "getting-started/quickstart" },
            { label: "Tutorial", slug: "getting-started/tutorial" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Fuzzing Primer", slug: "concepts/fuzzing-primer" },
            { label: "How Vitiate Works", slug: "concepts/how-it-works" },
            {
              label: "Corpus and Regression Testing",
              slug: "concepts/corpus",
            },
          ],
        },
        {
          label: "Guides",
          items: [
            {
              label: "Structure-Aware Fuzzing",
              slug: "guides/structure-aware-fuzzing",
            },
            {
              label: "Dictionaries and Seeds",
              slug: "guides/dictionaries-and-seeds",
            },
            {
              label: "Vulnerability Detectors",
              slug: "guides/detectors",
            },
            { label: "CI Fuzzing", slug: "guides/ci-fuzzing" },
            { label: "Standalone CLI", slug: "guides/cli" },
            { label: "Troubleshooting", slug: "guides/troubleshooting" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "fuzz() API", slug: "reference/fuzz-api" },
            {
              label: "FuzzedDataProvider",
              slug: "reference/fuzzed-data-provider",
            },
            { label: "Plugin Options", slug: "reference/plugin-options" },
            { label: "CLI Flags", slug: "reference/cli-flags" },
            { label: "Detectors", slug: "reference/detectors" },
            {
              label: "Environment Variables",
              slug: "reference/environment-variables",
            },
          ],
        },
      ],
    }),
  ],
});
