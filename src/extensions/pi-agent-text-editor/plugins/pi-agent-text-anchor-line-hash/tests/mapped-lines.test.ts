import { createTextDocument, textLineAnchors, withTextSourceLine } from "pi-agent-text";
import { expect, test } from "vitest";

import { createLineHashPresenter } from "#src/read-handler.ts";

const file = "const a = 1;\n}\nconst b = 2;\n}\n";

function mappedDocument(withAnchor: boolean) {
  const document = createTextDocument("outline:src/a.ts", "const b = 2;\n}\n");
  const anchors = textLineAnchors("src/a.ts", file);
  return {
    ...document,
    lines: document.lines.map((line, index) =>
      withTextSourceLine(line, {
        source: "src/a.ts",
        lineNumber: index === 0 ? 3 : 4,
        content: line.content,
        ...(withAnchor && { anchor: anchors[index === 0 ? 2 : 3] }),
      }),
    ),
  };
}

test("a mapped line shows the anchor its producer computed from the whole source file", async () => {
  const presented = await createLineHashPresenter().present(mappedDocument(true), {
    purpose: "read",
    source: "outline:src/a.ts",
    cwd: "/workspace",
    resolvedBy: "outline",
  });
  const anchors = textLineAnchors("src/a.ts", file);

  expect(presented.lines.map((line) => line.presentation?.prefix)).toEqual([
    `${anchors[2]}|`,
    `${anchors[3]}|`,
  ]);
  // The two closing braces are different lines of the source, so they carry different anchors.
  expect(anchors[1]).not.toBe(anchors[3]);
  expect(presented.lines.map((line) => line.presentation?.compactPrefix)).toEqual(["3 │ ", "4 │ "]);
});

test("a mapped line without an anchor stays unanchored", async () => {
  const presented = await createLineHashPresenter().present(mappedDocument(false), {
    purpose: "read",
    source: "outline:src/a.ts",
    cwd: "/workspace",
    resolvedBy: "outline",
  });

  expect(presented.lines.every((line) => line.anchors === undefined)).toBe(true);
  expect(presented.lines.every((line) => line.presentation === undefined)).toBe(true);
});
