import { expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";
import { TextAnchor } from "pi-agent-text";
import { resolveExactTextAnchor } from "pi-agent-text-anchor-exact/api/anchor";
import type { TextMutationContext } from "#src/api/mutation-tool.js";
import { applyTextChanges, TextChangeDocument } from "#src/core/text-change-engine.js";
import { anchorSpanRange, deleteAnchorSpan, replaceAnchorSpan } from "#src/tools/text-selection.js";
import { copyMutationTool } from "#src/tools/tool-text-copy.js";
import { moveMutationTool } from "#src/tools/tool-text-move.js";
import { insertMutationTool } from "#src/tools/tool-text-insert.js";

class Position extends TextAnchor {
  constructor(line: number) {
    super("line", line);
  }
}

function fixture(
  contents: Readonly<Record<string, string>>,
  anchors: Readonly<Record<string, readonly [string, string | number]>>,
) {
  const documents = new Map(
    Object.entries(contents).map(([source, content]) => [source, new TextChangeDocument(content)]),
  );
  const documentFor = (source: string) => {
    const document = documents.get(source);
    if (document === undefined) throw new Error(`Missing fixture ${source}`);
    return document;
  };
  const resolve = (field: string) => {
    const entry = anchors[field];
    if (entry === undefined) throw new Error(`Missing fixture anchor ${field}`);
    const [source, value] = entry;
    if (typeof value === "number") return new Map([[source, new Position(value)]]);
    const content = documentFor(source).content;
    const resolved = resolveExactTextAnchor(value, {
      source,
      content,
      lines: content.split(/\r\n|\r|\n/u),
      cwd: process.cwd(),
    });
    if (resolved.kind !== "resolved") throw new Error(`Fixture anchor ${field} did not resolve`);
    return new Map([[source, resolved.anchor]]);
  };
  const context: TextMutationContext = {
    cwd: process.cwd(),
    sourceDocument: documentFor("source"),
    documentFor,
    sourceFor: (field) => (field === "target" ? "target" : "source"),
    targetDocument: () => documentFor("target"),
    resolveAnchors: async (field) => resolve(field),
    resolveAnchor: async (field) => requiredValue(resolve(field).values().next().value),
  };
  return { context, documentFor, resolve };
}

for (const eol of ["\n", "\r\n"]) {
  test.each([`keep${eol}`, `keep${eol}${eol}`, ""])(
    "line deletion owns no preceding separator (%j)",
    (prefix) => {
      const content = `${prefix}尾🙂`;
      const line = prefix.split(eol).length;
      const f = fixture({ source: content }, { start: ["source", line] });
      const span = anchorSpanRange(f.context, f.resolve("start"), undefined, "start", "end");
      const expected = { from: prefix.length, to: content.length, insert: "" };
      expect(f.documentFor("source").deleteLines(line, line)).toEqual(expected);
      expect(f.documentFor("source").replaceLines(line, line, "")).toEqual(expected);
      expect(deleteAnchorSpan(span)).toEqual(expected);
      expect(replaceAnchorSpan(f.context, span, "")).toEqual(expected);
      expect(applyTextChanges(content, [deleteAnchorSpan(span)]).content).toBe(prefix);
    },
  );

  test("empty whole-line replacement removes the line's own terminator", () => {
    const content = `keep${eol}尾🙂${eol}${eol}after`;
    const document = new TextChangeDocument(content);
    expect(document.replaceLines(2, 2, "")).toEqual(document.deleteLines(2, 2));
    expect(applyTextChanges(content, [document.replaceLines(2, 2, "")]).content).toBe(
      `keep${eol}${eol}after`,
    );
  });

  test("append then delete restores the original terminated EOF", () => {
    const original = `base${eol}`;
    const document = new TextChangeDocument(original);
    const appended = applyTextChanges(original, [document.insertAfterLine(1, "added")]).content;
    const after = new TextChangeDocument(appended);
    expect(applyTextChanges(appended, [after.deleteLines(2, 2)]).content).toBe(original);
  });
}

for (const operation of [copyMutationTool, moveMutationTool]) {
  for (const ending of ["", "\n", "\r\n"]) {
    test(`${operation.name} transfers the same whole-line source into an exact destination (${JSON.stringify(ending)})`, async () => {
      const content = `keep\r\n段🙂${ending}`;
      const f = fixture(
        { source: content, target: "left TARGET right\n" },
        {
          start: ["source", "段🙂"],
          targetStart: ["target", "TARGET"],
          targetEnd: ["target", "TARGET"],
        },
      );
      const result = await operation.mutate(f.context, {
        start: "段🙂",
        targetStart: "TARGET",
        targetEnd: "TARGET",
      });
      const target = result.edits.get("target");
      expect(target).toBeDefined();
      expect(applyTextChanges("left TARGET right\n", requiredValue(target).changes).content).toBe(
        `left 段🙂${ending} right\n`,
      );
      const deletion = result.edits.get("source");
      expect(
        deletion === undefined ? content : applyTextChanges(content, deletion.changes).content,
      ).toBe(operation.name === "copy" ? content : "keep\r\n");
    });
  }
}

for (const operation of [copyMutationTool, moveMutationTool]) {
  test(`${operation.name} replaces only the selected destination with the source bytes`, async () => {
    const f = fixture(
      { source: "keep\nTAIL", target: "before\nTARGET\nafter\n" },
      {
        start: ["source", "TAIL"],
        targetStart: ["target", "TARGET"],
        targetEnd: ["target", "TARGET"],
      },
    );
    const result = await operation.mutate(f.context, {
      start: "TAIL",
      targetStart: "TARGET",
      targetEnd: "TARGET",
    });
    expect(
      applyTextChanges("before\nTARGET\nafter\n", requiredValue(result.edits.get("target")).changes)
        .content,
    ).toBe("before\nTAILafter\n");
  });
}
for (const before of [false, true]) {
  test(`exact insertion uses the selected boundary (before=${before})`, async () => {
    const content = "pre α🙂 end\n";
    const f = fixture({ source: content }, { anchor: ["source", "α🙂"] });
    const result = await insertMutationTool.mutate(f.context, { anchor: "α🙂", text: "+", before });
    expect(
      applyTextChanges(content, requiredValue(result.edits.get("source")).changes).content,
    ).toBe(before ? "pre +α🙂 end\n" : "pre α🙂+ end\n");
  });

  test(`blank-line insertion keeps the exact boundary (before=${before})`, async () => {
    const content = "pre α🙂 end\n";
    const f = fixture({ source: content }, { anchor: ["source", "α🙂"] });
    const result = await insertMutationTool.mutate(f.context, {
      anchor: "α🙂",
      text: "+",
      before,
      separation: "blank-line",
    });
    expect(
      applyTextChanges(content, requiredValue(result.edits.get("source")).changes).content,
    ).toBe(before ? "pre \n\n+\n\nα🙂 end\n" : "pre α🙂\n\n+\n\n end\n");
  });
  test(`multiline exact insertion does not widen the selection (before=${before})`, async () => {
    const content = "pre α\r\nβ end\r\n";
    const f = fixture({ source: content }, { anchor: ["source", "α\nβ"] });
    const result = await insertMutationTool.mutate(f.context, {
      anchor: "α\nβ",
      text: "+",
      before,
    });
    expect(
      applyTextChanges(content, requiredValue(result.edits.get("source")).changes).content,
    ).toBe(before ? "pre +α\r\nβ end\r\n" : "pre α\r\nβ+ end\r\n");
  });
}
