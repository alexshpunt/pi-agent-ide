import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import { attachFileMutationTargets, NO_TEXT_TARGET } from "#src/core/file-result-targets.ts";

test.each(["directory", "symlink"] as const)(
  "a %s transfer receipt cannot follow a remote link or publish text authority",
  async (sourceKind) => {
    const store = new ResultTargetStore();
    let reads = 0;
    const result = await attachFileMutationTargets(
      {
        content: [{ type: "text", text: "copy: applied" }],
        details: {
          results: [],
          metadata: {
            semanticAction: {
              kind: "file-operation",
              operation: "copy",
              ok: true,
              effect: "applied",
              sourceKind,
              target: "ssh://fixture/tmp/object",
            },
          },
        },
      },
      store,
      "/tmp",
      undefined,
      async () => {
        reads++;
        throw Error("Object receipts must not request editable referent text");
      },
    );
    expect(reads).toBe(0);
    expect(result.details.metadata?.resultTarget).toBeUndefined();
    expect(result.details.metadata?.targetUnavailable).toBe(NO_TEXT_TARGET);
  },
);

test("a binary destination reports the plain no-text reason, not a decoder error", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-binary-target-"));
  try {
    await writeFile(path.join(cwd, "copy.bin"), Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00]));
    const result = await attachFileMutationTargets(
      {
        content: [{ type: "text", text: "copy: applied" }],
        details: {
          results: [],
          metadata: {
            semanticAction: {
              kind: "file-operation",
              operation: "copy",
              ok: true,
              effect: "applied",
              sourceKind: "file",
              target: "copy.bin",
            },
          },
        },
      },
      new ResultTargetStore(),
      cwd,
    );
    expect(result.details.metadata?.resultTarget).toBeUndefined();
    expect(result.details.metadata?.targetUnavailable).toBe(NO_TEXT_TARGET);
    expect(result.details.metadata?.resultFileStates).toEqual([
      { source: path.join(cwd, "copy.bin"), state: "present" },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
