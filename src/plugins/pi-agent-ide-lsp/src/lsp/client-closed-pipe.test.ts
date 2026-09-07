import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, test } from "vitest";

test.each(["notification", "request", "initialize"])(
  "contains a real closed-pipe %s failure in a separate Node process",
  async (mode) => {
    const parent = path.resolve(".agents/tmp/lsp-closed-pipe");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, "run-"));
    const outfile = path.join(root, "runner.mjs");
    try {
      await build({
        entryPoints: ["src/plugins/pi-agent-ide-lsp/src/lsp/test/fixtures/closed-pipe.ts"],
        outfile,
        bundle: true,

        alias: { "#src": path.resolve("src") },
        platform: "node",
        format: "esm",
        banner: {
          js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
        },
      });
      const result = await promisify(execFile)(process.execPath, [outfile, mode], {
        timeout: 10000,
      });
      expect(JSON.parse(result.stdout.trim())).toEqual({
        survived: true,
        rejected: true,
        failureCaught: mode !== "notification",
        ready: false,
        crashed: true,
      });
      expect(result.stderr).toContain("EPIPE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
