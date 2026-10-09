import { createTextDocument } from "pi-agent-text";
import { expect, test } from "vitest";

import { createLineHashAnchor } from "#src/anchor.js";
import { createLineHashPresenter } from "#src/read-handler.js";

test.each([
  { source: "notes.txt", resolvedBy: "filesystem" },
  { source: "ssh://fixture/work/notes.txt", resolvedBy: "ssh" },
])("presents current line-hash anchors for $resolvedBy", async ({ source, resolvedBy }) => {
  const document = createTextDocument(source, "alpha\nbravo");
  const presented = await createLineHashPresenter().present(document, {
    purpose: "edit-diff",
    source,
    cwd: "/workspace",
    resolvedBy,
  });

  expect(presented.lines.map((line) => line.presentation?.prefix)).toEqual([
    `${createLineHashAnchor(1, "alpha").value}|`,
    `${createLineHashAnchor(2, "bravo").value}|`,
  ]);
});

test("converted file text does not gain physical line anchors", async () => {
  const document = createTextDocument("ssh://fixture/work/records.jsonl", "42\n");
  const presented = await createLineHashPresenter().present(document, {
    purpose: "read",
    source: document.source,
    sourceText: '{"id":42}\n',
    cwd: "/workspace",
    resolvedBy: "ssh",
  });
  expect(presented.lines.every((line) => line.anchors === undefined)).toBe(true);
});
test("Read without a retained physical snapshot does not gain line anchors", async () => {
  const document = createTextDocument("ssh://fixture/work/identity.json", "42\n");
  const presented = await createLineHashPresenter().present(document, {
    purpose: "read",
    source: document.source,
    cwd: "/workspace",
    resolvedBy: "ssh",
  });
  expect(presented.lines.every((line) => line.anchors === undefined)).toBe(true);
});
test("unrelated derived text does not gain physical line anchors", async () => {
  const document = createTextDocument("web:ssh://fixture/https://example.invalid", "alpha\nbravo");
  const presented = await createLineHashPresenter().present(document, {
    purpose: "read",
    source: document.source,
    cwd: "/workspace",
    resolvedBy: "web",
  });
  expect(presented.lines.every((line) => line.anchors === undefined)).toBe(true);
});
