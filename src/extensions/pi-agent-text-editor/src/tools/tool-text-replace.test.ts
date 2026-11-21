import { describe, expect, test } from "vitest";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.ts";
import { TextChangeDocument } from "#src/core/text-change-engine.ts";
import { replaceMutationTool } from "#src/tools/tool-text-replace.ts";

const source = "file.txt";

/** Supply an already-resolved exact match, as the production anchor resolver would. */
function fixture(content: string, selectors: Readonly<Record<string, string | undefined>>) {
  const document = new TextChangeDocument(content);
  async function resolveAnchors(field: string) {
    const value = selectors[field];
    if (value === undefined) throw new Error(`Unexpected selector: ${field}`);
    const from = content.indexOf(value);
    if (from < 0) throw new Error(`Invalid test fixture: ${value}`);
    const position = (offset: number) => {
      const lineNumber = document.lineNumberAt(offset);
      return { lineNumber, column: offset - document.lineRange(lineNumber, lineNumber).from };
    };
    return new Map([
      [
        source,
        new TextSelectionAnchor(value, source, [
          { start: position(from), end: position(from + value.length) },
        ]),
      ],
    ]);
  }
  const context = {
    cwd: ".",
    sourceDocument: document,
    targetDocument: () => document,
    sourceFor: () => source,
    documentFor: () => document,
    resolveAnchors,
    async resolveAnchor(): Promise<never> {
      throw new Error("Unexpected single-anchor request");
    },
  };
  return async (text: string) => {
    const mutation = await replaceMutationTool.mutate(context, { ...selectors, text });
    const changes = mutation.edits.get(source)?.changes ?? [];
    return changes.reduceRight(
      (input, { from, to, insert }) => input.slice(0, from) + insert + input.slice(to),
      content,
    );
  };
}

describe("replace exclusive boundaries", () => {
  test.each([
    {
      name: "a section through the blank line before the next heading",
      input: "## Section 5\nold body\n\n## Section 6\nnext\n",
      selectors: { start: "## Section 5", before: "## Section 6" },
      text: "## Section 5\nnew body\n",
      expected: "## Section 5\nnew body\n## Section 6\nnext\n",
    },
    {
      name: "whole lines inside CRLF markers after a BOM",
      input: "\uFEFF// BEGIN\r\nold body\r\n\r\n// END",
      selectors: { after: "// BEGIN", before: "// END" },
      text: "new\nbody\n",
      expected: "\uFEFF// BEGIN\r\nnew\r\nbody\r\n// END",
    },
    {
      name: "a single blank line between markers",
      input: "BEGIN\n\nEND\n",
      selectors: { after: "BEGIN", before: "END" },
      text: "",
      expected: "BEGIN\nEND\n",
    },
    {
      name: "characters after an inline boundary through the inclusive end",
      input: "x = old; // keep\n",
      selectors: { after: "x = ", end: ";" },
      text: "new;",
      expected: "x = new; // keep\n",
    },
    {
      name: "the remainder of a line after an inline boundary",
      input: "x = old\nEND\n",
      selectors: { after: "x = ", before: "END" },
      text: "new",
      expected: "x = new\nEND\n",
    },
    {
      name: "an empty span between adjacent CRLF marker lines",
      input: "BEGIN\r\nEND",
      selectors: { after: "BEGIN", before: "END" },
      text: "a\nb",
      expected: "BEGIN\r\na\r\nb\r\nEND",
    },
    {
      name: "an empty marker block with a single replacement line",
      input: "BEGIN\nEND\n",
      selectors: { after: "BEGIN", before: "END" },
      text: "new",
      expected: "BEGIN\nnew\nEND\n",
    },
    {
      name: "a separator that is part of the closing match",
      input: "BEGIN\nEND\n",
      selectors: { after: "BEGIN", before: "\nEND" },
      text: "new",
      expected: "BEGINnew\nEND\n",
    },
    {
      name: "an empty span between adjacent characters",
      input: "x = ;\n",
      selectors: { after: "x = ", before: ";" },
      text: "new",
      expected: "x = new;\n",
    },
  ])("replaces $name", async ({ input, selectors, text, expected }) => {
    await expect(fixture(input, selectors)(text)).resolves.toBe(expected);
  });

  test("refuses empty text over adjacent marker lines", async () => {
    const replace = fixture("BEGIN\nEND\n", { after: "BEGIN", before: "END" });
    await expect(replace("")).rejects.toMatchObject({ code: "REPLACEMENT_IDENTICAL" });
  });
});
