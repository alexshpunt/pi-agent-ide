import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { SearchSessionStore } from "#src/search-session.js";

test("repeats saved scope once per session and retains incomplete and failed observations", async () => {
  const root = path.resolve(".agents/tmp/search-observation");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  const source = path.join(cwd, "a.txt");
  try {
    await writeFile(source, "old\n");
    const store = new SearchSessionStore();
    const session = await store.register(
      "old",
      [
        {
          source,
          lineNumber: 1,
          startColumn: 0,
          endColumn: 3,
          matchedText: "old",
          lineText: "old",
        },
      ],
      true,
      cwd,
      undefined,
      { query: "old", path: source, limit: 1 },
    );
    const anchors = [`SEARCH#${session.id}:1:match`, `SEARCH#${session.id}:all:match`];
    await writeFile(source, "old\nold\n");
    const remaining = await store.observeAfterEdit(anchors);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ matches: 1, complete: false });
    await writeFile(source, "new\n");
    expect(await store.observeAfterEdit(anchors)).toMatchObject([{ matches: 0, complete: true }]);
    await rm(source);
    const failed = await store.observeAfterEdit(anchors);
    expect(failed[0]?.error).toBeTypeOf("string");
    expect(failed[0]?.matches).toBeUndefined();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
