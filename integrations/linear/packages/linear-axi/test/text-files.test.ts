import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "#axi/cli.ts";
import type { Runtime } from "#axi/types.ts";

void test("project description-file preserves complete UTF-8 text and sends no local filename", async () => {
  await mkdir(".tmp", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/text-files-"));
  const calls: Array<[string, unknown]> = [];
  const runtime: Runtime = {
    cwd,
    env: {},
    stdout: process.stdout,
    mcpUrl: "https://example.org",
    client: {
      listTools: async () => [{ name: "get_project" }, { name: "update_project" }],
      callTool: async (name, args) => {
        calls.push([name, args]);
        return {
          structuredContent: { id: "project", name: "Keep name", description: args.description },
        };
      },
    },
  };
  try {
    for (const content of ["Full description\nРусский & quotes\n", ""]) {
      await writeFile(path.join(cwd, "body.md"), content);
      await run(
        ["projects", "update", "--id", "project", "--description-file", "body.md"],
        runtime,
      );
      assert.deepEqual(calls.at(-1), ["update_project", { id: "project", description: content }]);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
