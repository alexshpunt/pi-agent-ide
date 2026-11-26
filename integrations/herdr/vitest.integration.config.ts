import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/**/*.integration.test.ts"], maxWorkers: 1, fileParallelism: false },
});
