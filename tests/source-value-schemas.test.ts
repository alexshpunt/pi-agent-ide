import { describe, expect, test } from "vitest";
import type { TSchema } from "typebox";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { readToolParameters } from "#src/extensions/pi-agent-read/src/api/read-parameters.ts";
import { searchSchema } from "#src/extensions/pi-agent-search/src/api/search-parameters.ts";
import { astSearchSchema } from "#src/plugins/pi-agent-ide-ast/src/tool-ast-search.ts";
import { lspSearchSchema } from "#src/plugins/pi-agent-ide-lsp/src/tool-lsp-search.ts";
import { replaceSchema } from "#src/extensions/pi-agent-text-editor/src/tools/tool-text-replace.ts";
import { insertSchema } from "#src/extensions/pi-agent-text-editor/src/tools/tool-text-insert.ts";
import { deleteSchema } from "#src/extensions/pi-agent-text-editor/src/tools/tool-text-delete.ts";
import { writeSchema } from "#src/extensions/pi-agent-text-editor/src/tools/tool-text-write.ts";
import { copySchema } from "#src/extensions/pi-agent-text-editor/src/tools/tool-text-copy.ts";
import { moveSchema } from "#src/extensions/pi-agent-text-editor/src/tools/tool-text-move.ts";
import { undoSchema } from "#src/plugins/pi-agent-ide-changes/src/tool-text-undo.ts";
import { diffParameters } from "#src/extensions/pi-agent-text-editor/src/core/diff-tool.ts";

const id = "RESULT#00000000-0000-4000-8000-000000000000";
/** A Codemode value: its id selects text, its other fields are data for the script. */
const value = { id, text: "a\n", complete: true };

/** Tool, schema, source fields, and whether those fields take a list of sources. */
const tools: readonly (readonly [string, TSchema, readonly string[], boolean])[] = [
  ["read", readToolParameters, ["path"], true],
  ["search", searchSchema, ["path"], true],
  ["ast_search", astSearchSchema, ["path"], true],
  ["lsp_search", lspSearchSchema, ["path"], true],
  ["replace", replaceSchema, ["path"], true],
  ["insert", insertSchema, ["path"], true],
  ["delete", deleteSchema, ["path"], true],
  ["write", writeSchema, ["path"], true],
  ["copy", copySchema, ["path", "target"], true],
  ["move", moveSchema, ["path", "target"], true],
  ["undo", undoSchema, ["file"], true],
  ["diff", diffParameters, ["before", "after"], false],
];

/** Pi's own argument validation, which runs before any IDE hook sees the call. */
function validate(name: string, parameters: TSchema, input: JsonObject): unknown {
  return validateToolArguments(
    { name, description: name, parameters },
    { type: "toolCall", id: "call", name, arguments: input },
  );
}

/** Arguments that the schema requires besides the source fields. */
const required: Record<string, JsonObject> = {
  search: { query: "a" },
  ast_search: { pattern: "a" },
  replace: { text: "a" },
  insert: { text: "a" },
  write: { content: "a" },
  undo: { change: "last" },
};

describe("source parameters accept a Codemode value with an id", () => {
  test.each(tools)("%s", (name, parameters, fields, lists) => {
    for (const field of fields) {
      // Diff needs both sides; the other one is a plain path.
      const sides: JsonObject = name === "diff" ? { before: "a.txt", after: "a.txt" } : {};
      const base: JsonObject = { ...required[name], ...sides };
      expect(validate(name, parameters, { ...base, [field]: value })).toMatchObject({
        [field]: value,
      });
      expect(validate(name, parameters, { ...base, [field]: id })).toMatchObject({
        [field]: id,
      });
      if (lists)
        expect(validate(name, parameters, { ...base, [field]: [value, "a.txt"] })).toMatchObject({
          [field]: [value, "a.txt"],
        });
      // Diff also takes Read's request object, so only the other tools reject an object without id.
      if (name !== "diff")
        expect(() => validate(name, parameters, { ...base, [field]: { text: "a\n" } })).toThrow(
          /Validation failed/u,
        );
    }
  });
});

/** Tool, schema and selector fields that take anchor text or a value with an id. */
const selectors: readonly (readonly [string, TSchema, readonly string[]])[] = [
  ["replace", replaceSchema, ["start", "end"]],
  ["delete", deleteSchema, ["start", "end"]],
  ["insert", insertSchema, ["anchor"]],
  ["copy", copySchema, ["start", "end", "targetStart", "targetEnd"]],
  ["move", moveSchema, ["start", "end", "targetStart", "targetEnd"]],
];

describe("selector parameters accept a Codemode value with an id", () => {
  test.each(selectors)("%s", (name, parameters, fields) => {
    for (const field of fields) {
      const base: JsonObject = { ...required[name], path: "a.txt" };
      expect(validate(name, parameters, { ...base, [field]: value })).toMatchObject({
        [field]: value,
      });
      expect(validate(name, parameters, { ...base, [field]: "OLD" })).toMatchObject({
        [field]: "OLD",
      });
      expect(() => validate(name, parameters, { ...base, [field]: { text: "a\n" } })).toThrow(
        /Validation failed/u,
      );
      expect(() => validate(name, parameters, { ...base, [field]: [value] })).toThrow(
        /Validation failed/u,
      );
    }
  });
});
