import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["benchmarks/tool-capabilities/web-search-fixture.integration.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
