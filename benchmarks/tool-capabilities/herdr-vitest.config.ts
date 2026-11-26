import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["benchmarks/tool-capabilities/herdr-fixture.integration.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
