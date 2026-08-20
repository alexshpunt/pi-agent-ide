import { createTextDocument } from "pi-agent-text";
import { expect, test } from "vitest";

import { createLineHashAnchor } from "#src/anchor.js";
import { createLineHashPresenter } from "#src/read-handler.js";

test("presents current line-hash anchors", async () => {
  const document = createTextDocument("notes.txt", "alpha\nbravo");
  const presented = await createLineHashPresenter().present(document, {
    purpose: "edit-diff",
    source: "notes.txt",
    cwd: "/workspace",
    resolvedBy: "filesystem",
  });

  expect(presented.lines.map((line) => line.presentation?.prefix)).toEqual([
    `${createLineHashAnchor(1, "alpha").value}|`,
    `${createLineHashAnchor(2, "bravo").value}|`,
  ]);
});
