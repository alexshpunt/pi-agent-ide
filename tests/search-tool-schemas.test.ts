import { expect, test } from "vitest";
import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";
import { astSearchSchema } from "#src/plugins/pi-agent-ide-ast/src/tool-ast-search.js";
import { lspSearchSchema } from "#src/plugins/pi-agent-ide-lsp/src/tool-lsp-search.js";

test.each([
  ["ast_search", astSearchSchema],
  ["lsp_search", lspSearchSchema],
])("%s serializes an optional result-input path without compositor metadata", (_, schema) => {
  expect(Type.IsOptional(schema.properties.path)).toBe(true);
  const { description: _description, ...path } = JSON.parse(
    JSON.stringify(schema.properties.path),
  ) as Record<string, unknown>;
  expect(path).toEqual(JSON.parse(JSON.stringify(resultInputSchema)));
});
