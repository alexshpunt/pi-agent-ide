import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repoRoot = new URL("./", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);
const require = createRequire(import.meta.url);
process.chdir(repoRootPath);
delete process.env.PI_INTEGRATION_TEST_RUNNER;
process.env.PI_SKIP_VERSION_CHECK = "1";

export default defineConfig({
  root: repoRootPath,
  resolve: {
    alias: [
      {
        find: /^pi-coding-agent-test$/u,
        replacement: fileURLToPath(
          new URL("tests/integration/support/pi-runtime/pi-coding-agent-test.ts", repoRoot),
        ),
      },
      {
        find: "@xterm/headless",
        replacement: require.resolve("@xterm/headless"),
      },
    ],
  },
  test: {
    testTimeout: 60_000,
    include: ["tests/integration/**/*.integration.test.ts"],
    fileParallelism: false,
  },
});
