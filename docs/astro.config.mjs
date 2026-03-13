// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightThemeRapide from "starlight-theme-rapide";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightLinksValidator from "starlight-links-validator";

// https://astro.build/config
export default defineConfig({
  site: "https://vitiate.js.org",
  integrations: [
    starlight({
      plugins: [
        starlightThemeRapide(),
        starlightLlmsTxt({
          description:
            "Vitiate is a coverage-guided JavaScript/TypeScript fuzzer built as a Vitest plugin. " +
            "Uses SWC for compile-time instrumentation and LibAFL for mutation-driven fuzzing.",
          // Order pages to match the natural reading flow: overview and
          // getting-started first, concepts and guides in the middle,
          // reference material last.
          promote: [
            "index",
            "**/introduction",
            "getting-started/**",
            "concepts/**",
          ],
          demote: ["reference/**", "**/troubleshooting"],
          customSets: [
            {
              label: "Getting started and concepts",
              description:
                "introduction, quickstart, tutorial, and core concepts",
              paths: ["getting-started/**", "concepts/**"],
            },
            {
              label: "Guides",
              description:
                "practical guides for structure-aware fuzzing, detectors, CI integration, and more",
              paths: ["guides/**"],
            },
            {
              label: "API and configuration reference",
              description:
                "fuzz() API, FuzzedDataProvider, plugin options, CLI flags, and environment variables",
              paths: ["reference/**"],
            },
          ],
        }),
        starlightLinksValidator(),
      ],
      title: "Vitiate",
      customCss: ["./src/styles/custom.css"],
      routeMiddleware: "./src/routeData.ts",
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
            {
              label: "Migrating from Jazzer.js",
              slug: "guides/migrating-from-jazzerjs",
            },
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
