import test from "node:test";
import assert from "node:assert/strict";
import { run } from "#axi/cli.ts";
import type { Runtime } from "#axi/types.ts";

void test("asset CLI forwards only explicit upload fields and retains partial effects", async () => {
  const calls: unknown[] = [];
  const runtime: Runtime = {
    cwd: process.cwd(),
    env: {},
    stdout: process.stdout,
    mcpUrl: "https://example.org",
    client: {
      listTools: async () => [],
      callTool: async () => {
        throw new Error("No MCP calls expected");
      },
    },
    storageClient: {
      upload: async (input) => {
        calls.push(input);
        return {
          workspace: "example",
          filename: "proof.zip",
          size: 9,
          sha256: "hash",
          upload: "applied",
          assetUrl: "https://uploads.linear.app/proof.zip",
          attachment: { effect: "not-applied", error: "LINEAR_PERMISSION_DENIED" },
        };
      },
      download: async () => {
        throw new Error("Not expected");
      },
    },
  };
  const output = await run(
    [
      "assets",
      "upload",
      "--file",
      "proof.zip",
      "--workspace",
      "example",
      "--issue",
      "ENG-12",
      "--title",
      "Proof",
    ],
    runtime,
  );
  assert.match(output, /upload: applied/);
  assert.match(output, /effect: not-applied/);
  assert.deepEqual(calls[0], {
    cwd: process.cwd(),
    file: "proof.zip",
    workspace: "example",
    issue: "ENG-12",
    title: "Proof",
    contentType: undefined,
  });
  await assert.rejects(
    () =>
      run(
        [
          "assets",
          "upload",
          "--file",
          "proof.zip",
          "--workspace",
          "example",
          "--make-public",
          "true",
        ],
        runtime,
      ),
    /invalid asset operation/,
  );
  assert.equal(calls.length, 1);
});
