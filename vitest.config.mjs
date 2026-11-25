import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repoRootPath = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  root: repoRootPath,
  test: {
    // A timing flake passes on a repeat; a real failure fails all three attempts. Only CI
    // repeats, so a developer still sees a flaky test on the first run.
    retry: process.env.CI ? 2 : 0,
    include: [
      "src/**/*.test.ts",
      "tests/**/*.test.ts",
      "packages/**/*.test.ts",
      "integrations/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/integration/**", "integrations/**/*.integration.test.ts"],
  },
});
