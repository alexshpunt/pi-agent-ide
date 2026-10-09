import { expect, test } from "vitest";
import { guardFileOperation } from "#src/core/file-operation-guards.js";
import type { TextMutationPlan } from "#src/api/mutation-guard.js";

const context = { cwd: "/local", intent: "mixed" as const };

test("a mixed move guard sees both modified snapshots before any effect", async () => {
  const files = new Map([
    ["/local/source", Buffer.from("local café")],
    ["ssh://target/dest", Buffer.from("remote café")],
  ]);
  let seen: TextMutationPlan | undefined;
  await expect(
    guardFileOperation(
      "move",
      { path: "/local/source", target: "ssh://target/dest" },
      context,
      async (source) => ({ source, bytes: files.get(source) }),
      [
        {
          id: "deny",
          guard(plan) {
            seen = plan;
            return {
              kind: "rejected",
              rejection: {
                code: "MUTATION_REJECTED",
                reason: "locked",
                message: "locked",
                effect: "not-applied",
              },
            };
          },
        },
      ],
    ),
  ).rejects.toMatchObject({ code: "MUTATION_REJECTED", effect: "not-applied" });
  expect(
    seen?.resources.map((item) => [item.source, item.before.content, item.after.content]),
  ).toEqual([
    ["/local/source", "local café", ""],
    ["ssh://target/dest", "remote café", "local café"],
  ]);
  expect(files.get("/local/source")).toEqual(Buffer.from("local café"));
});

test("binary snapshots preserve bytes instead of inventing decoded text", async () => {
  const bytes = Buffer.from([0, 255, 128]);
  let seen: TextMutationPlan | undefined;
  await guardFileOperation(
    "copy",
    { path: "/local/source", target: "ssh://target/dest" },
    context,
    async (source) => ({ source, bytes: source === "/local/source" ? bytes : undefined }),
    [
      {
        id: "inspect",
        guard(plan) {
          seen = plan;
          return { kind: "accepted" };
        },
      },
    ],
  );
  expect(seen?.resources).toHaveLength(1);
  expect(seen?.resources[0]?.after.content).toBe("");
  expect(seen?.resources[0]?.binary?.after).toEqual(bytes);
});

test("text plans preserve a UTF-8 BOM instead of dropping file bytes", async () => {
  let before: string | undefined;
  await guardFileOperation(
    "delete",
    { path: "/local/bom" },
    context,
    async (source) => ({ source, bytes: Buffer.from("\uFEFFcafé\r\n") }),
    [
      {
        id: "inspect",
        guard(plan) {
          before = plan.resources[0]?.before.content;
          return { kind: "accepted" };
        },
      },
    ],
  );
  expect(before).toBe("\uFEFFcafé\r\n");
});
test("a guard cannot approve a stale snapshot or write after cancellation", async () => {
  let bytes = Buffer.from("before");
  const read = async (source: string) => ({ source, bytes });
  await expect(
    guardFileOperation("delete", { path: "/local/source" }, context, read, [
      {
        id: "race",
        guard() {
          bytes = Buffer.from("external");
          return { kind: "accepted" };
        },
      },
    ]),
  ).rejects.toMatchObject({ code: "CONFLICT", effect: "not-applied" });
  const controller = new AbortController();
  const reason = new Error("Cancel my guarded operation");
  await expect(
    guardFileOperation(
      "delete",
      { path: "/local/source" },
      { ...context, signal: controller.signal },
      read,
      [
        {
          id: "cancel",
          guard() {
            controller.abort(reason);
            return { kind: "accepted" };
          },
        },
      ],
    ),
  ).rejects.toBe(reason);
});
