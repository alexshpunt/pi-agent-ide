import { createTextDocument, type TextAnchorResolverContext } from "pi-agent-text";
import { resolveExactTextAnchor } from "pi-agent-text-anchor-exact/api/anchor";
import { expect, test } from "vitest";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";
import { TextAnchorRegistry } from "#src/core/text-anchor-registry.js";
import { TextChangeDocument } from "#src/core/text-change-engine.js";

const source = "/workspace/notes.txt";
function context(content: string): TextAnchorResolverContext {
  const document = createTextDocument(source, content);
  return { source, content, cwd: "/workspace", lines: document.lines.map((line) => line.content) };
}
function registry(resolve = resolveExactTextAnchor) {
  const anchors = new TextAnchorRegistry();
  anchors.add({
    kind: "fixture/exact",
    type: "auxiliary",
    resolver: {
      id: "exact",
      description: "Resolve an exact selection in the real document.",
      renderFull: (value) => value,
      renderCompact: (value) => value,
      tryResolve: (value, document) => Promise.resolve(resolve(value, document)),
    },
  });
  return anchors.snapshot();
}

test.each(["\n", "\r\n", ""])(
  "exact EOF endpoints select only original bytes (%j)",
  async (ending) => {
    const content = `First${ending || "\n"}Last${ending}`;
    const resolved = await registry().resolve("Last", context(content));
    expect(TextSelectionAnchor.is(resolved)).toBe(true);
    if (!TextSelectionAnchor.is(resolved)) throw new Error("Missing exact selection");
    const range = resolved.ranges[0];
    if (!range) throw new Error("Missing exact range");
    const document = new TextChangeDocument(content);
    const extent = document.range(
      range.start.lineNumber,
      range.start.column,
      range.end.lineNumber,
      range.end.column,
    );
    expect(document.text(extent)).toBe(`Last${ending}`);
    expect(extent.to).toBe(content.length);
  },
);

test.each([
  { lineNumber: 3, column: 1 },
  { lineNumber: 4, column: 0 },
])("a virtual EOF line does not allow an invalid endpoint %j", async (end) => {
  const anchors = registry((value) => ({
    kind: "resolved",
    anchor: new TextSelectionAnchor(value, source, [{ start: { lineNumber: 2, column: 0 }, end }]),
  }));
  await expect(anchors.resolve("Last", context("First\nLast\n"))).rejects.toThrow(
    "outside the current text",
  );
});
