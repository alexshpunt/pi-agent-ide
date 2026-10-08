import { defineConfig } from "oxlint";

/** Use explicitly for the experiment; warnings do not block normal development. */
export default defineConfig({
  categories: { correctness: "off" },
  jsPlugins: [{ name: "prose-experiment", specifier: "./plugin.ts" }],
  rules: { "prose-experiment/no-prose-assertions": "warn" },
  ignorePatterns: [
    ".pi/**",
    ".agents/**",
    ".tmp/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/fixtures/**",
    "**/__fixtures__/**",
  ],
});
