import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const repoRoot = new URL("../../../../../../../../../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);
process.chdir(repoRootPath);

export default defineConfig({
    root: repoRootPath,
    resolve: {
        alias: {
            "@xterm/headless": fileURLToPath(
                new URL("node_modules/@xterm/headless/lib-headless/xterm-headless.js", repoRoot),
            ),
        },
    },
    plugins: [tsconfigPaths()],
    test: {
        testTimeout: 30000,
        include: [
            "agent/src/extensions/pi-agent-ide/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/tests/integration/*.integration.test.ts",
        ],
        fileParallelism: false,
    },
});
