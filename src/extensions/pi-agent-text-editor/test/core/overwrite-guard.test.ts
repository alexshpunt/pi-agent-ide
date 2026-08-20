import { createTextDocument } from "pi-agent-text";
import { expect, test } from "vitest";

import { createOverwriteGuard } from "#overwrite/index.js";

import type { TextMutationPlan } from "#src/api/mutation-guard.js";

const context = { cwd: "/workspace" };

function plan(after: string): TextMutationPlan {
  const before = createTextDocument("/workspace/file.txt", "before\n");
  return {
    resources: [
      {
        source: before.source,
        existed: true,
        before,
        after: createTextDocument(before.source, after),
        changes: [
          {
            fromBefore: 0,
            toBefore: before.content.length,
            fromAfter: 0,
            toAfter: after.length,
            removedText: before.content,
            insertedText: after,
          },
        ],
      },
    ],
  };
}

function inspect(
  registration: ReturnType<typeof createOverwriteGuard>,
  mutation: TextMutationPlan,
) {
  return Promise.resolve(registration.guard(mutation, context));
}

test("allows the same full overwrite automatically on its second attempt", async () => {
  const registration = createOverwriteGuard();

  await expect(inspect(registration, plan("after\n"))).resolves.toMatchObject({ kind: "rejected" });
  await expect(inspect(registration, plan("after\n"))).resolves.toEqual({ kind: "accepted" });
  await expect(inspect(registration, plan("after\n"))).resolves.toMatchObject({ kind: "rejected" });
});

test("does not reuse an attempt for different final content", async () => {
  const registration = createOverwriteGuard();

  await expect(inspect(registration, plan("first\n"))).resolves.toMatchObject({ kind: "rejected" });
  await expect(inspect(registration, plan("second\n"))).resolves.toMatchObject({
    kind: "rejected",
  });
});
