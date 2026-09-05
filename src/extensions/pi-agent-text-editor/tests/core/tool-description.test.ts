import { Type } from "typebox";
import { expect, test } from "vitest";

import { appendSchemaFieldOrder } from "#src/core/tool-description.js";
import { copySchema } from "#src/tools/tool-text-copy.js";
import { deleteSchema } from "#src/tools/tool-text-delete.js";
import { insertSchema } from "#src/tools/tool-text-insert.js";
import { moveSchema } from "#src/tools/tool-text-move.js";
import { replaceSchema } from "#src/tools/tool-text-replace.js";

test("appends schema fields in declaration order", () => {
  const schema = Type.Object({
    path: Type.Optional(Type.String()),
    start: Type.String(),
    end: Type.Optional(Type.String()),
    text: Type.String(),
  });

  expect(appendSchemaFieldOrder("Replace selected lines.", schema)).toBe(
    "Replace selected lines.\nArgument order: `path`, `start`, `end`, `text`.",
  );
});

test("describes mutation source fields as resource references", () => {
  for (const schema of [replaceSchema, insertSchema, deleteSchema, copySchema, moveSchema]) {
    expect(JSON.stringify(schema.properties.path)).toContain("resource reference or file path");
  }

  for (const schema of [replaceSchema, insertSchema, deleteSchema]) {
    expect(JSON.stringify(schema.properties.path)).toContain("typed SEARCH#... resource");
  }

  for (const schema of [copySchema, moveSchema]) {
    expect(JSON.stringify(schema.properties.target)).toContain("resource reference or file path");
  }
});
