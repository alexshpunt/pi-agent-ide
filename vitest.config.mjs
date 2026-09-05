import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repoRootPath = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  root: repoRootPath,
  test: {
    include: [
      "src/**/*.test.ts",
      "tests/**/*.test.ts",
      "packages/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/integration/**"],
  },
});
