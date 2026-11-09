import { expect, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import type { TextTarget } from "pi-agent-text";
import { expandReferenceList } from "./reference-list.ts";

const cwd = "/workspace";
const range = (column: number, end: number) => ({
  start: { lineNumber: 1, column },
  end: { lineNumber: 1, column: end },
});

function fixture() {
  const targets = new Map<string, TextTarget>([
    [
      "SEARCH#AAAA:1:match",
      { source: "/workspace/a.txt", expectedContent: "alpha beta\n", ranges: [range(0, 5)] },
    ],
    [
      "SEARCH#AAAA:2:match",
      { source: "/workspace/a.txt", expectedContent: "alpha beta\n", ranges: [range(6, 10)] },
    ],
    [
      "SEARCH#BBBB:1:line",
      { source: "/workspace/b.txt", expectedContent: "gamma\n", ranges: [range(0, 5)] },
    ],
    ["SEARCH#CCCC:1:match", { source: "/workspace/c.txt", expectedContent: "no range" }],
  ]);
  const core = {
    resolveTextAnchorResources: (value: string) => {
      const target = targets.get(value);
      if (target === undefined) return Promise.reject(new Error("The Search result expired."));
      return Promise.resolve([target]);
    },
  };
  return { core, store: new ResultTargetStore() };
}

test("expands Search references from different results into ordered handles", async () => {
  const { core, store } = fixture();
  const handles = await expandReferenceList(
    core,
    store,
    ["SEARCH#BBBB:1:line", "SEARCH#AAAA:1:match", "SEARCH#AAAA:2:match"],
    cwd,
  );
  expect(handles).toHaveLength(3);
  expect(store.resolve(handles[0], cwd).targets[0]?.source).toBe("/workspace/b.txt");
  const all = store.resolve(handles, cwd);
  expect(all.complete).toBe(true);
  expect(all.targets.find((target) => target.source === "/workspace/a.txt")?.ranges).toEqual([
    range(0, 5),
    range(6, 10),
  ]);
});

test("accepts issued RESULT# handles next to Search references", async () => {
  const { core, store } = fixture();
  const issued = store.register(
    [{ source: "/workspace/d.txt", expectedContent: "delta\n", ranges: [range(0, 5)] }],
    cwd,
  );
  const handles = await expandReferenceList(core, store, [issued, "SEARCH#AAAA:1:match"], cwd);
  expect(handles[0]).toBe(issued);
  expect(handles).toHaveLength(2);
});

test("names the first unusable item and changes nothing", async () => {
  const { core, store } = fixture();
  await expect(
    expandReferenceList(core, store, ["SEARCH#AAAA:1:match", "SEARCH#ZZZZ:1:match"], cwd),
  ).rejects.toThrow(/Reference SEARCH#ZZZZ:1:match cannot be used: The Search result expired/u);
  await expect(
    expandReferenceList(core, store, ["RESULT#00000000-0000-4000-8000-000000000000"], cwd),
  ).rejects.toThrow(/Reference RESULT#0000.* cannot be used/u);
  await expect(expandReferenceList(core, store, ["SEARCH#CCCC:1:match"], cwd)).rejects.toThrow(
    /SEARCH#CCCC:1:match cannot be used: It does not select a text range/u,
  );
});

test("reports every unusable item in one error and changes nothing", async () => {
  const { core, store } = fixture();
  const error = await expandReferenceList(
    core,
    store,
    ["SEARCH#ZZZZ:1:match", "SEARCH#AAAA:1:match", "src/a.txt", "SEARCH#CCCC:1:match"],
    cwd,
  ).catch((caught: unknown) => caught);
  const message = error instanceof Error ? error.message : "";
  expect(message).toContain("3 of 4 references cannot be used; nothing was changed");
  expect(message).toContain("Reference SEARCH#ZZZZ:1:match cannot be used");
  expect(message).toContain("Reference src/a.txt cannot be used");
  expect(message).toContain("Reference SEARCH#CCCC:1:match cannot be used");
  expect(message).not.toContain("SEARCH#AAAA:1:match");
});

test("rejects a plain path in an array and says how to pass one", async () => {
  const { core, store } = fixture();
  await expect(
    expandReferenceList(core, store, ["SEARCH#AAAA:1:match", "src/a.txt"], cwd),
  ).rejects.toThrow(
    /Reference src\/a\.txt cannot be used: It is a path\. Arrays hold references only/u,
  );
});
