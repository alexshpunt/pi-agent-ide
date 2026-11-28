import { createTextDocument } from "pi-agent-text";
import { expect, test } from "vitest";

import { formatLineHashAnchor } from "#src/anchor.ts";
import { createLineHashPresenter } from "#src/read-handler.ts";
import { LineHashRangeHistory } from "#src/range-history.ts";

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
    `${formatLineHashAnchor("alpha\nbravo", 1)}|`,
    `${formatLineHashAnchor("alpha\nbravo", 2)}|`,
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
test("edit presentation anchors only the shown lines, padded like the whole file", async () => {
  const content = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");
  const document = createTextDocument("notes.txt", content);
  const context = {
    purpose: "edit-diff",
    source: "notes.txt",
    cwd: "/workspace",
    resolvedBy: "filesystem",
  } as const;
  const presenter = createLineHashPresenter();
  const whole = await presenter.present(document, context);
  const shown = await presenter.present(document, { ...context, lineNumbers: new Set([8, 9]) });

  expect(shown.lines.slice(7, 9)).toEqual(whole.lines.slice(7, 9));
  expect(shown.lines[7]?.presentation?.prefix).toBe(`${formatLineHashAnchor(content, 8)}|`);
  expect(shown.lines.filter((line) => line.presentation !== undefined)).toHaveLength(2);
});

test("sparse physical windows retain whole-file anchors and range history", async () => {
  const content = "first\nrepeat\n}\nnext\nrepeat\n}\nlast";
  const document = createTextDocument("notes.txt", content);
  const history = new LineHashRangeHistory();
  const presented = await createLineHashPresenter(history).present(document, {
    purpose: "read",
    source: "notes.txt",
    sourceText: content,
    cwd: "/workspace",
    resolvedBy: "filesystem",
    lineNumbers: new Set([2, 5]),
  });
  const first = formatLineHashAnchor(content, 2);
  const last = formatLineHashAnchor(content, 5);
  expect(presented.lines[1]?.presentation?.prefix).toBe(`${first}|`);
  expect(presented.lines[4]?.presentation?.prefix).toBe(`${last}|`);
  expect(presented.lines.filter((line) => line.presentation !== undefined)).toHaveLength(2);
  expect(history.check("notes.txt", first, last, "repeat\n}\nnext\nrepeat\n")).toBe("unchanged");
  expect(history.check("notes.txt", first, last, "repeat\n}\nedit\nrepeat\n")).toBe("changed");
});

test("presenting a small window does not exceed the argument limit for a large file", async () => {
  const content = Array.from({ length: 150_000 }, (_, index) => `line ${index}`).join("\n");
  const document = createTextDocument("notes.txt", content);
  const presented = await createLineHashPresenter().present(document, {
    purpose: "read",
    source: "notes.txt",
    sourceText: content,
    cwd: "/workspace",
    resolvedBy: "filesystem",
    lineNumbers: new Set([100]),
  });
  expect(presented.lines[99]?.presentation?.compactPrefix).toBe("   100 │ ");
});
