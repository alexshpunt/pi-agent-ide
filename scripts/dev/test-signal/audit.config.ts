import testSignal from "eslint-plugin-test-signal";
import { defineConfig } from "oxlint";

/** Upstream rules are advisory and test-only; default lint is not changed. */
export default defineConfig({
  categories: { correctness: "off" },
  jsPlugins: [{ name: "test-signal", specifier: "eslint-plugin-test-signal" }],
  overrides: [
    {
      files: [
        "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
        "**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
      ],
      rules: Object.fromEntries(
        Object.keys(testSignal.configs.all.rules).map((name) => [name, "warn"]),
      ),
    },
  ],
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
