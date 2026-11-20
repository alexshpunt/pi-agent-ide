import { describe, expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";
import { TextAnchor } from "pi-agent-text";
import { resolveExactTextAnchor } from "pi-agent-text-anchor-exact/api/anchor";
import type { TextMutationContext, TextMutationToolRegistration } from "#src/api/mutation-tool.ts";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.ts";
import { applyTextChanges, TextChangeDocument } from "#src/core/text-change-engine.ts";
import { copyMutationTool } from "#src/tools/tool-text-copy.ts";
import { deleteMutationTool } from "#src/tools/tool-text-delete.ts";
import { insertMutationTool } from "#src/tools/tool-text-insert.ts";
import { moveMutationTool } from "#src/tools/tool-text-move.ts";
import { replaceMutationTool } from "#src/tools/tool-text-replace.ts";

/** A line anchor, such as a line-hash anchor from Read. */
class LineAnchor extends TextAnchor {
  public constructor(lineNumber: number) {
    super(`line ${lineNumber}`, lineNumber);
  }
}

/**
 * A file around one target line: `prefix + content + ending + suffix`. `startEnding` is the line
 * ending of the target line, or of the line before it when it has none. `afterEnding` is the line
 * ending at the start of the line after it, where an insertion after the line lands.
 */
interface Shape {
  readonly name: string;
  readonly prefix: string;
  readonly content: string;
  readonly ending: string;
  readonly suffix: string;
  readonly startEnding: string;
  readonly afterEnding: string;
}

const shapes: readonly Shape[] = [
  {
    name: "BOM and LF",
    prefix: "\uFEFF",
    content: "TARGET",
    ending: "\n",
    suffix: "next\n",
    startEnding: "\n",
    afterEnding: "\n",
  },
  {
    name: "CRLF",
    prefix: "one\r\n",
    content: "TARGET",
    ending: "\r\n",
    suffix: "last\r\n",
    startEnding: "\r\n",
    afterEnding: "\r\n",
  },
  {
    name: "mixed endings",
    prefix: "one\n",
    content: "TARGET",
    ending: "\r\n",
    suffix: "last\n",
    startEnding: "\r\n",
    afterEnding: "\n",
  },
  {
    name: "a lone CR inside the line",
    prefix: "one\n",
    content: "TAR\rGET",
    ending: "\n",
    suffix: "last\n",
    startEnding: "\n",
    afterEnding: "\n",
  },
  {
    name: "the last line of a CRLF file without a final line break",
    prefix: "one\r\n",
    content: "TARGET",
    ending: "",
    suffix: "",
    startEnding: "\r\n",
    afterEnding: "\r\n",
  },
  {
    name: "the last line of a BOM file that ends with LF",
    prefix: "\uFEFFone\n",
    content: "TARGET",
    ending: "\n",
    suffix: "",
    startEnding: "\n",
    afterEnding: "\n",
  },
];

const source = "file.txt";

function contentOf(shape: Shape): string {
  return shape.prefix + shape.content + shape.ending + shape.suffix;
}

function targetLine(shape: Shape): number {
  return shape.prefix.split("\n").length;
}

/** How a selector names the target; every kind resolves only a span. */
interface Selector {
  readonly name: string;
  readonly anchors: (shape: Shape) => {
    readonly start: TextAnchor;
    readonly end?: TextAnchor;
  };
}

function exactText(shape: Shape): TextAnchor {
  const content = contentOf(shape);
  const resolved = resolveExactTextAnchor(shape.content, {
    source,
    content,
    lines: content.split("\n"),
    cwd: process.cwd(),
  });
  if (resolved.kind !== "resolved") throw new Error("The exact text did not resolve");
  return resolved.anchor;
}

/** A selection of the target line, as SEARCH :line, a Read result or an AST outline makes it. */
function lineSelection(shape: Shape): TextSelectionAnchor {
  const line = targetLine(shape);
  return new TextSelectionAnchor("SEARCH#1:1:line", source, [
    {
      start: { lineNumber: line, column: 0 },
      end:
        shape.ending === ""
          ? { lineNumber: line, column: shape.content.length }
          : { lineNumber: line + 1, column: 0 },
      linewise: true,
    },
  ]);
}

/** A selection of the line's characters, as SEARCH :match, an LSP or an AST match makes it. */
function matchSelection(shape: Shape): TextSelectionAnchor {
  const line = targetLine(shape);
  const column = line === 1 ? shape.prefix.length : 0;
  return new TextSelectionAnchor("SEARCH#1:1:match", source, [
    {
      start: { lineNumber: line, column },
      end: { lineNumber: line, column: column + shape.content.length },
    },
  ]);
}

const selectors: readonly Selector[] = [
  { name: "exact text", anchors: (shape) => ({ start: exactText(shape) }) },
  {
    name: "a line anchor",
    anchors: (shape) => ({ start: new LineAnchor(targetLine(shape)) }),
  },
  { name: "SEARCH :line", anchors: (shape) => ({ start: lineSelection(shape) }) },
  { name: "SEARCH :match", anchors: (shape) => ({ start: matchSelection(shape) }) },
  {
    name: "a result with an exact range through the line ending",
    anchors: (shape) => ({
      start: new TextSelectionAnchor("RESULT#1", source, [
        {
          start: {
            lineNumber: targetLine(shape),
            column: targetLine(shape) === 1 ? shape.prefix.length : 0,
          },
          end:
            shape.ending === ""
              ? requiredValue(matchSelection(shape).ranges[0]).end
              : { lineNumber: targetLine(shape) + 1, column: 0 },
        },
      ]),
    }),
  },
  {
    name: "a line range",
    anchors: (shape) => ({
      start: new LineAnchor(targetLine(shape)),
      end: new LineAnchor(targetLine(shape)),
    }),
  },
  {
    name: "exact text to a line anchor",
    anchors: (shape) => ({ start: exactText(shape), end: new LineAnchor(targetLine(shape)) }),
  },
];

function context(content: string, anchors: Readonly<Record<string, TextAnchor>>) {
  const document = new TextChangeDocument(content);
  const resolve = (field: string) => new Map([[source, requiredValue(anchors[field])]]);
  const mutationContext: TextMutationContext = {
    cwd: process.cwd(),
    sourceDocument: document,
    documentFor: () => document,
    sourceFor: () => source,
    targetDocument: () => document,
    resolveAnchors: async (field) => resolve(field),
    resolveAnchor: async (field) => requiredValue(anchors[field]),
  };
  return mutationContext;
}

async function run(
  tool: TextMutationToolRegistration,
  content: string,
  anchors: Readonly<Record<string, TextAnchor>>,
  parameters: Record<string, unknown>,
): Promise<string> {
  const result = await tool.mutate(context(content, anchors), parameters);
  return applyTextChanges(content, requiredValue(result.edits.get(source)).changes).content;
}

describe.each(shapes)("on $name", (shape) => {
  const content = contentOf(shape);
  const { prefix, ending, suffix, startEnding: start, afterEnding: after } = shape;
  const sent = "A\nB";

  describe.each(selectors)("$name", (selector) => {
    const { start: startAnchor, end } = selector.anchors(shape);
    const anchors: Record<string, TextAnchor> =
      end === undefined ? { start: startAnchor } : { start: startAnchor, end };
    const range = end === undefined ? {} : { end: "end" };

    test("replace writes line breaks with the line's ending and keeps the rest", async () => {
      expect(
        await run(replaceMutationTool, content, anchors, { start: "start", ...range, text: sent }),
      ).toBe(`${prefix}A${start}B${ending}${suffix}`);
    });

    test("replace with a trailing line break", async () => {
      expect(
        await run(replaceMutationTool, content, anchors, {
          start: "start",
          ...range,
          text: `${sent}\n`,
        }),
      ).toBe(`${prefix}A${start}B${ending}${suffix}`);
    });

    test("delete removes the span and nothing outside it", async () => {
      const removedLine =
        ending === "" ? prefix.slice(0, prefix.length - start.length) : prefix + suffix;
      expect(await run(deleteMutationTool, content, anchors, { start: "start", ...range })).toBe(
        removedLine,
      );
    });

    test("empty replacement removes the line", async () => {
      const removedLine =
        ending === "" ? prefix.slice(0, prefix.length - start.length) : prefix + suffix;
      expect(
        await run(replaceMutationTool, content, anchors, { start: "start", ...range, text: "" }),
      ).toBe(removedLine);
    });

    test.each([1, 2])(
      "replacement with %i line breaks leaves that many empty lines",
      async (count) => {
        expect(
          await run(replaceMutationTool, content, anchors, {
            start: "start",
            ...range,
            text: "\n".repeat(count),
          }),
        ).toBe(prefix + start.repeat(count - 1) + ending + suffix);
      },
    );

    if (end !== undefined) return;

    test.each([sent, `\n${sent}\n`])("insert before with text %j", async (text) => {
      expect(
        await run(
          insertMutationTool,
          content,
          { anchor: startAnchor },
          {
            anchor: "anchor",
            text,
            before: true,
          },
        ),
      ).toBe(`${prefix}A${start}B${start}${shape.content}${ending}${suffix}`);
    });

    test.each([sent, `\n${sent}\n`])("insert after with text %j", async (text) => {
      const lineInsertion =
        ending === ""
          ? `${prefix}${shape.content}${after}A${after}B`
          : `${prefix}${shape.content}${ending}A${after}B${after}${suffix}`;
      expect(
        await run(
          insertMutationTool,
          content,
          { anchor: startAnchor },
          {
            anchor: "anchor",
            text,
          },
        ),
      ).toBe(lineInsertion);
    });

    test("inserting a line after and deleting it restores the original bytes", async () => {
      const inserted = await run(
        insertMutationTool,
        content,
        { anchor: startAnchor },
        {
          anchor: "anchor",
          text: "added\n",
        },
      );
      const addedLine = targetLine(shape) + 1;
      expect(
        await run(
          deleteMutationTool,
          inserted,
          { start: new LineAnchor(addedLine) },
          {
            start: "start",
          },
        ),
      ).toBe(content);
    });
  });
});

describe("whole-line replacement", () => {
  test.each(["\n", "\r\n"])(
    "includes a blank line named by a mixed end anchor (%j)",
    async (eol) => {
      const content = ["before", "START", "", "after", ""].join(eol);
      const start = new TextSelectionAnchor("START", source, [
        { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 5 } },
      ]);
      expect(
        await run(
          deleteMutationTool,
          content,
          { start, end: new LineAnchor(3) },
          {
            start: "start",
            end: "end",
          },
        ),
      ).toBe(["before", "after", ""].join(eol));
    },
  );

  test("keeps the selected line separate from the next one", async () => {
    const content = "one\ntwo\nthree\n";
    expect(
      await run(
        replaceMutationTool,
        content,
        { start: new LineAnchor(2) },
        {
          start: "start",
          text: "TWO",
        },
      ),
    ).toBe("one\nTWO\nthree\n");
  });

  test("of several lines keeps each untouched ending and the last line's own", async () => {
    const content = "one\r\ntwo\nthree\r\nfour";
    expect(
      await run(
        replaceMutationTool,
        content,
        { start: new LineAnchor(2), end: new LineAnchor(3) },
        { start: "start", end: "end", text: "X\nY\n" },
      ),
    ).toBe("one\r\nX\nY\r\nfour");
  });
});

describe("selections of several ranges", () => {
  test("a merged selection writes every range with its line's ending (LPT-1726)", async () => {
    // An explicit literal selector merged with a typed-path line selection in one anchor.
    const content = "keep\r\nalpha\r\nbeta\r\nend\r\n";
    const merged = new TextSelectionAnchor("start", source, [
      { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 5 } },
      { start: { lineNumber: 3, column: 0 }, end: { lineNumber: 4, column: 0 }, linewise: true },
    ]);
    expect(
      await run(replaceMutationTool, content, { start: merged }, { start: "start", text: "A\nB" }),
    ).toBe("keep\r\nA\r\nB\r\nA\r\nB\r\nend\r\n");
  });

  test("deleting adjacent whole lines that end the file leaves no empty line", async () => {
    const content = "keep\nalpha\nbeta";
    const lines = new TextSelectionAnchor("start", source, [
      { start: { lineNumber: 2, column: 0 }, end: { lineNumber: 3, column: 0 }, linewise: true },
      { start: { lineNumber: 3, column: 0 }, end: { lineNumber: 3, column: 4 } },
    ]);
    expect(await run(deleteMutationTool, content, { start: lines }, { start: "start" })).toBe(
      "keep",
    );
  });
});

describe("copy and move", () => {
  test.each([copyMutationTool, moveMutationTool])(
    "$name from an exact whole line onto a partial span",
    async (tool) => {
      const content = "block\nkeep\nleft SLOT right\n";
      const anchors = {
        start: new TextSelectionAnchor("block", source, [
          { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 2, column: 0 } },
        ]),
        targetStart: new TextSelectionAnchor("SLOT", source, [
          { start: { lineNumber: 3, column: 5 }, end: { lineNumber: 3, column: 9 } },
        ]),
      };
      expect(
        await run(
          tool,
          content,
          { ...anchors, targetEnd: anchors.targetStart },
          {
            start: "start",
            targetStart: "targetStart",
            targetEnd: "targetEnd",
          },
        ),
      ).toBe((tool === copyMutationTool ? "block\n" : "") + "keep\nleft block right\n");
    },
  );

  test.each([copyMutationTool, moveMutationTool])(
    "$name from exact text to an exact boundary",
    async (tool) => {
      const content = "block\nkeep\nslot\nnext\n";
      const anchors = {
        start: new TextSelectionAnchor("block", source, [
          { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 5 } },
        ]),
        targetStart: new TextSelectionAnchor("slot", source, [
          { start: { lineNumber: 3, column: 0 }, end: { lineNumber: 3, column: 4 } },
        ]),
      };
      expect(
        await run(tool, content, anchors, {
          start: "start",
          targetStart: "targetStart",
        }),
      ).toBe((tool === copyMutationTool ? "block\n" : "") + "keep\nslot\nblock\nnext\n");
    },
  );

  test("keep the copied bytes and separate them with the target's line ending", async () => {
    const content = "one\ntwo\r\nthree\r\nfour\n";
    const anchors = {
      start: new LineAnchor(2),
      end: new LineAnchor(3),
      targetStart: new LineAnchor(4),
    };
    expect(
      await run(copyMutationTool, content, anchors, {
        start: "start",
        end: "end",
        targetStart: "targetStart",
      }),
    ).toBe("one\ntwo\r\nthree\r\nfour\ntwo\r\nthree\n");
    expect(
      await run(moveMutationTool, content, anchors, {
        start: "start",
        end: "end",
        targetStart: "targetStart",
      }),
    ).toBe("one\nfour\ntwo\r\nthree\n");
  });

  test("moving the last line of a file without a final line break keeps it without", async () => {
    const content = "one\r\ntwo\r\nlast";
    expect(
      await run(
        moveMutationTool,
        content,
        { start: new LineAnchor(3), targetStart: new LineAnchor(1) },
        { start: "start", targetStart: "targetStart" },
      ),
    ).toBe("one\r\nlast\r\ntwo");
  });

  test("copy over whole lines replaces their content and keeps the last line's ending", async () => {
    const content = "SOURCE\nold\r\nkeep\n";
    expect(
      await run(
        copyMutationTool,
        content,
        {
          start: new LineAnchor(1),
          targetStart: new LineAnchor(2),
          targetEnd: new LineAnchor(2),
        },
        { start: "start", targetStart: "targetStart", targetEnd: "targetEnd" },
      ),
    ).toBe("SOURCE\nSOURCE\r\nkeep\n");
  });
});

describe.each([
  {
    name: "LF",
    prefix: "head\n",
    ending: "\n",
    suffix: "tail\n",
  },
  {
    name: "BOM and CRLF",
    prefix: "\uFEFFhead\r\n",
    ending: "\r\n",
    suffix: "tail\r\n",
  },
])("look-alike characters retyped by the model on $name", ({ prefix, ending, suffix }) => {
  const original = "export\u00A0default \u201Croutes\u201D \u2013 old;";
  const shape: Shape = {
    name: "look-alikes",
    prefix,
    content: original,
    ending,
    suffix,
    startEnding: ending,
    afterEnding: ending,
  };
  const content = contentOf(shape);

  describe.each(selectors)("$name", (selector) => {
    const { start: startAnchor, end } = selector.anchors(shape);
    const anchors: Record<string, TextAnchor> =
      end === undefined ? { start: startAnchor } : { start: startAnchor, end };
    const range = end === undefined ? {} : { end: "end" };
    const replace = (text: string) =>
      run(replaceMutationTool, content, anchors, { start: "start", ...range, text });

    test("keeps the original bytes outside the part the model changes", async () => {
      expect(await replace('export default "routes" - new;')).toBe(
        `${prefix}export\u00A0default \u201Croutes\u201D \u2013 new;${ending}${suffix}`,
      );
    });

    test("writes a whole span that only normalizes them as sent", async () => {
      expect(await replace('export default "routes" - old;')).toBe(
        `${prefix}export default "routes" - old;${ending}${suffix}`,
      );
    });

    test("still refuses a replacement identical to the selection", async () => {
      await expect(replace(original)).rejects.toMatchObject({ code: "REPLACEMENT_IDENTICAL" });
    });
  });
});

describe("look-alike characters in an insertion", () => {
  test("are written as sent, since an insertion replaces nothing", async () => {
    expect(
      await run(
        insertMutationTool,
        "a\u00A0b\nc\n",
        { anchor: new LineAnchor(1) },
        { anchor: "anchor", text: "d e" },
      ),
    ).toBe("a\u00A0bd e\nc\n");
  });
});

describe("a BOM in the text written at the start of a file (LPT-1740)", () => {
  const bomShape: Shape = {
    name: "a BOM file",
    prefix: "\uFEFF",
    content: "TARGET",
    ending: "\n",
    suffix: "next\n",
    startEnding: "\n",
    afterEnding: "\n",
  };
  const plainShape: Shape = { ...bomShape, name: "a file without a BOM", prefix: "" };

  // Exact text that starts with a BOM, as a model copies it from Read.
  function exactTextWithBom(shape: Shape): TextAnchor {
    const content = contentOf(shape);
    const resolved = resolveExactTextAnchor(`\uFEFF${shape.content}`, {
      source,
      content,
      lines: content.split("\n"),
      cwd: process.cwd(),
    });
    if (resolved.kind !== "resolved") throw new Error("The exact text did not resolve");
    return resolved.anchor;
  }

  const bomSelectors: readonly Selector[] = [
    ...selectors,
    {
      name: "exact text that starts with a BOM",
      anchors: (shape) => ({ start: exactTextWithBom(shape) }),
    },
  ];

  // A file keeps exactly the BOM it had; a model that writes a BOM into a file without one writes
  // it as sent. Both results start with one BOM, and nothing outside the span changes.
  describe.each([bomShape, plainShape])("$name", (shape) => {
    describe.each(bomSelectors)("$name", (selector) => {
      const { start: startAnchor, end } = selector.anchors(shape);
      const anchors: Record<string, TextAnchor> =
        end === undefined ? { start: startAnchor } : { start: startAnchor, end };
      const range = end === undefined ? {} : { end: "end" };

      test("replace writes one BOM", async () => {
        expect(
          await run(replaceMutationTool, contentOf(shape), anchors, {
            start: "start",
            ...range,
            text: "\uFEFFNEW",
          }),
        ).toBe("\uFEFFNEW\nnext\n");
      });

      test("replace with text that has no BOM keeps the file's BOM", async () => {
        expect(
          await run(replaceMutationTool, contentOf(shape), anchors, {
            start: "start",
            ...range,
            text: "NEW",
          }),
        ).toBe(`${shape.prefix}NEW\nnext\n`);
      });

      if (end !== undefined) return;

      test("insert at the start writes one BOM", async () => {
        expect(
          await run(
            insertMutationTool,
            contentOf(shape),
            { anchor: startAnchor },
            { anchor: "anchor", text: "\uFEFFA", before: true },
          ),
        ).toBe("\uFEFFATARGET\nnext\n");
      });
    });
  });

  test("a BOM further into the file is written as sent", async () => {
    expect(
      await run(
        replaceMutationTool,
        "\uFEFFone\ntwo\n",
        { start: new LineAnchor(2) },
        { start: "start", text: "\uFEFFtwo" },
      ),
    ).toBe("\uFEFFone\n\uFEFFtwo\n");
    expect(
      await run(
        insertMutationTool,
        "\uFEFFone\n",
        { anchor: new LineAnchor(1) },
        { anchor: "anchor", text: "\uFEFFtwo\n" },
      ),
    ).toBe("\uFEFFone\n\uFEFFtwo\n");
  });

  test("only one leading BOM of the text is dropped", () => {
    const document = new TextChangeDocument("\uFEFFone\n");
    expect(document.replace(document.lineSpan(1, 1), "\uFEFF\uFEFFNEW").insert).toBe("\uFEFFNEW");
  });

  test("copied bytes drop a leading BOM too", () => {
    const document = new TextChangeDocument("\uFEFFone\n");
    const span = document.lineSpan(1, 1);
    const payload = { text: "\uFEFFNEW", wholeLines: true };
    expect(document.replace(span, payload).insert).toBe("NEW");
    expect(document.insert(span, payload, { before: true }).insert).toBe("NEW\n");
  });

  test("text that is only a BOM inserts nothing", () => {
    const document = new TextChangeDocument("\uFEFFone\n");
    expect(() => document.insert(document.lineSpan(1, 1), "\uFEFF", { before: true })).toThrow(
      /empty/u,
    );
  });

  test("a whole-file write keeps the BOM it is given", () => {
    const document = new TextChangeDocument("\uFEFFone\n");
    expect(document.replaceAll("\uFEFF\uFEFFone\n").insert).toBe("\uFEFF\uFEFFone\n");
  });
});
