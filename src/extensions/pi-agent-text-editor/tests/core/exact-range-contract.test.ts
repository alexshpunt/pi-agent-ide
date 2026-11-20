import { expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";
import { TextAnchor } from "pi-agent-text";
import { resolveExactTextAnchor } from "pi-agent-text-anchor-exact/api/anchor";
import type { TextMutationContext } from "#src/api/mutation-tool.ts";
import { applyTextChanges, TextChangeDocument } from "#src/core/text-change-engine.ts";
import { anchorSpanRange } from "#src/tools/text-selection.ts";
import { copyMutationTool } from "#src/tools/tool-text-copy.ts";
import { moveMutationTool } from "#src/tools/tool-text-move.ts";
import { insertMutationTool } from "#src/tools/tool-text-insert.ts";

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
      lines: content.split("\n"),
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
    "deleting an unterminated last line also removes the line ending before it (%j)",
    async (prefix) => {
      const content = `${prefix}尾🙂`;
      const line = prefix.split(eol).length;
      const f = fixture({ source: content }, { start: ["source", line] });
      const span = await anchorSpanRange(f.context, f.resolve("start"), undefined, "start", "end");
      const document = f.documentFor("source");
      const kept = prefix.slice(0, Math.max(0, prefix.length - eol.length));
      const expected = { from: kept.length, to: content.length, insert: "" };
      expect(document.delete(span)).toEqual(expected);
      expect(document.replace(span, "")).toEqual(expected);
      expect(applyTextChanges(content, [document.delete(span)]).content).toBe(kept);
    },
  );

  test("empty whole-line replacement removes the line's own terminator", () => {
    const content = `keep${eol}尾🙂${eol}${eol}after`;
    const document = new TextChangeDocument(content);
    const line = document.lineSpan(2, 2);
    expect(document.replace(line, "")).toEqual(document.delete(line));
    expect(applyTextChanges(content, [document.replace(line, "")]).content).toBe(
      `keep${eol}${eol}after`,
    );
  });
}

for (const original of ["base\n", "base\r\n", "base", "\uFEFFbase\r\n"]) {
  test(`insert after the last line, then delete it, restores the original bytes (${JSON.stringify(original)})`, () => {
    const document = new TextChangeDocument(original);
    const appended = applyTextChanges(original, [
      document.insert(document.lineSpan(1, 1), "added\n"),
    ]).content;
    const after = new TextChangeDocument(appended);
    expect(after.text(after.lineSpan(2, 2))).toBe("added");
    expect(applyTextChanges(appended, [after.delete(after.lineSpan(2, 2))]).content).toBe(original);
  });
}

for (const operation of [copyMutationTool, moveMutationTool]) {
  for (const ending of ["", "\n", "\r\n"]) {
    test(`${operation.name} transfers a whole line as characters onto a partial target (LPT-1747) (${JSON.stringify(ending)})`, async () => {
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
        "left 段🙂 right\n",
      );
      const deletion = result.edits.get("source");
      expect(
        deletion === undefined ? content : applyTextChanges(content, deletion.changes).content,
      ).toBe(operation.name === "copy" ? content : ending === "" ? "keep" : "keep\r\n");
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
    ).toBe("before\nTAIL\nafter\n");
  });
}
for (const before of [false, true]) {
  test(`exact insertion uses the selected boundary (before=${before})`, async () => {
    const content = "pre α🙂 end\n";
    const f = fixture({ source: content }, { anchor: ["source", "α🙂"] });
    const result = await insertMutationTool.mutate(f.context, {
      anchor: "α🙂",
      text: "+",
      before,
    });
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
    ).toBe(before ? "pre +α🙂 end\n" : "pre α🙂+ end\n");
  });
  test(`inserting multiline text mid-line keeps the character boundary (before=${before})`, async () => {
    const content = "pre α\r\nβ end\r\n";
    const f = fixture({ source: content }, { anchor: ["source", "α\r\nβ"] });
    const result = await insertMutationTool.mutate(f.context, {
      anchor: "α\r\nβ",
      text: "X\nY",
      before,
    });
    expect(
      applyTextChanges(content, requiredValue(result.edits.get("source")).changes).content,
    ).toBe(before ? "pre X\r\nYα\r\nβ end\r\n" : "pre α\r\nβX\r\nY end\r\n");
  });
}
