import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repoRoot = new URL("./", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);
const require = createRequire(import.meta.url);
process.chdir(repoRootPath);
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE = "1";

const GIB = 1024 ** 3;
const MAX_PI = 30;

function configuredLimit() {
  const value = process.env.PI_INTEGRATION_TEST_MAX_PI;
  if (value === undefined) return MAX_PI;
  const limit = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("PI_INTEGRATION_TEST_MAX_PI must be a positive integer.");
  }
  return Math.min(MAX_PI, limit);
}

export function integrationWorkerLimit({ pooled = false } = {}) {
  // Budget for Vitest, Pi and workspace language servers. Pooled runs can also keep idle Pi
  // processes alive while running standalone fixtures. Leave 2 GiB for the rest of the machine.
  const perWorker = (pooled ? 2 : 1.25) * GIB;
  const memorySlots = Math.floor((process.availableMemory() - 2 * GIB) / perWorker);
  return Math.max(1, Math.min(configuredLimit(), availableParallelism(), memorySlots));
}

function requirePoolLimit(ceiling) {
  /** @type {unknown} */
  let endpoint;
  try {
    endpoint = JSON.parse(process.env.PI_INTEGRATION_TEST_RUNNER ?? "null");
  } catch {
    throw new Error("Invalid pi-test runner endpoint.");
  }
  const capacity =
    typeof endpoint === "object" && endpoint !== null && "maxPi" in endpoint
      ? endpoint.maxPi
      : undefined;
  if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error(
      "Pooled mode needs a pi-test runner that advertises maxPi. Set PI_TEST_CLI to a compatible executable, or use --parallel.",
    );
  }
  if (capacity > ceiling) {
    throw new Error(
      `The pi-test pool limit (${capacity}) exceeds the requested limit (${ceiling}).`,
    );
  }
  return capacity;
}

const mode = process.env.PI_AGENT_IDE_INTEGRATION_MODE;
const parallel = mode === "parallel" || mode === "pooled";
const requestedWorkers = parallel ? integrationWorkerLimit({ pooled: mode === "pooled" }) : 1;
const maxWorkers =
  mode === "pooled"
    ? Math.min(requestedWorkers, requirePoolLimit(configuredLimit()))
    : requestedWorkers;

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
    // A timing flake passes on a repeat; a real failure fails all three attempts. Only CI
    // repeats, so a developer still sees a flaky test on the first run.
    retry: process.env.CI ? 2 : 0,
    include: ["tests/integration/**/*.integration.test.ts"],
    fileParallelism: parallel,
    ...(parallel && { pool: "forks", maxWorkers, maxConcurrency: 1 }),
  },
});
