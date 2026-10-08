import { expect, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import { attachFileMutationTargets } from "#src/core/file-result-targets.js";

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
    expect(result.details.metadata?.targetUnavailable).toBeDefined();
  },
);
