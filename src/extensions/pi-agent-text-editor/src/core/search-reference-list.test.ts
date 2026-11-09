import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import type { TextTarget } from "pi-agent-text";
import { hasSearchReference, resolveSearchReferenceList } from "./search-reference-list.ts";

const range = (column: number, end: number) => ({
  start: { lineNumber: 1, column },
  end: { lineNumber: 1, column: end },
});

test("detects Search references only in lists", () => {
  expect(hasSearchReference(["SEARCH#ABCD:1:match"])).toBe(true);
  expect(hasSearchReference(["RESULT#1", "note.txt"])).toBe(false);
  expect(hasSearchReference("SEARCH#ABCD:1:match")).toBe(false);
});

test("resolves Search references from different results and names the rejected one", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "search-reference-list-"));
  try {
    const first = path.join(cwd, "first.txt");
    const second = path.join(cwd, "second.txt");
    await writeFile(first, "alpha beta\n");
    await writeFile(second, "gamma\n");
    const targets = new Map<string, TextTarget>([
      [
        "SEARCH#AAAA:1:match",
        { source: first, expectedContent: "alpha beta\n", ranges: [range(0, 5)] },
      ],
      [
        "SEARCH#AAAA:2:match",
        { source: first, expectedContent: "alpha beta\n", ranges: [range(6, 10)] },
      ],
      [
        "SEARCH#BBBB:1:match",
        { source: second, expectedContent: "gamma\n", ranges: [range(0, 5)] },
      ],
    ]);
    const core = {
      resolveTextAnchorResources: (value: string) => {
        const target = targets.get(value);
        if (target === undefined) return Promise.reject(new Error("The Search result expired."));
        return Promise.resolve([target]);
      },
    };
    const store = new ResultTargetStore();

    const selected = await resolveSearchReferenceList(
      core,
      store,
      ["SEARCH#AAAA:1:match", "SEARCH#AAAA:2:match", "SEARCH#BBBB:1:match"],
      cwd,
    );
    expect(selected.complete).toBe(true);
    expect(selected.targets).toEqual([
      { source: first, expectedContent: "alpha beta\n", ranges: [range(0, 5), range(6, 10)] },
      { source: second, expectedContent: "gamma\n", ranges: [range(0, 5)] },
    ]);

    await expect(
      resolveSearchReferenceList(core, store, ["SEARCH#AAAA:1:match", "SEARCH#CCCC:1:match"], cwd),
    ).rejects.toThrow(/SEARCH#CCCC:1:match.*expired/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects a Search reference that selects no range", async () => {
  const store = new ResultTargetStore();
  const core = {
    resolveTextAnchorResources: () =>
      Promise.resolve([{ source: "/tmp/file.txt", expectedContent: "text" }]),
  };
  await expect(
    resolveSearchReferenceList(core, store, ["SEARCH#AAAA:1:match"], "/tmp"),
  ).rejects.toThrow(/SEARCH#AAAA:1:match cannot be used: It does not select a text range/u);
});
