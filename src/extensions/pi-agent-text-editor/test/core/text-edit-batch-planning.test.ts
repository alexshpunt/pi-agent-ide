import { Type } from "typebox";
import { expect, test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AnyTextMutationToolRegistration } from "#src/api/mutation-tool.js";
import { planRegisteredTextBatch } from "#src/core/text-edit-batch-registrar.js";

test("independent batch mutations plan together and still reject conflicts in call order", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registration: AnyTextMutationToolRegistration = {
    name: "fixture",
    description: "Plan a replacement",
    parameters: Type.Object({ path: Type.String() }),
    source: { field: "path" },
    async mutate(context) {
      const source = context.sourceFor("path");
      if (source === "first.txt") await gate;
      else release();
      return {
        edits: new Map([
          [source, { changes: [{ from: 0, to: 1, insert: "X" }], action: "edited" }],
        ]),
      };
    },
  };
  const pending = planRegisteredTextBatch(
    new Map([["fixture", registration]]),
    {
      edits: [
        { callId: "first", op: "fixture", path: "first.txt" },
        { callId: "second", op: "fixture", path: "second.txt" },
        { callId: "conflict", op: "fixture", path: "second.txt" },
      ],
    },
    new Map([
      ["first.txt", "A"],
      ["second.txt", "B"],
    ]),
    async () => {
      throw new Error("No anchors in this fixture");
    },
    { cwd: "/workspace" } as ExtensionContext,
    undefined,
    () => {},
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Batch planning was serialized")), 500);
      }),
    ]);
    expect(result.mutations.map((entry) => entry.callId)).toEqual(["first", "second"]);
    expect(result.failures.map((entry) => entry.callId)).toEqual(["conflict"]);
  } finally {
    clearTimeout(timer);
    release();
    await pending;
  }
});
