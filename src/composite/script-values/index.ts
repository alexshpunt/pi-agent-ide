import { astSearchValue } from "./ast-search.ts";
import { copyValue } from "./copy.ts";
import { deleteValue } from "./delete.ts";
import { diffValue } from "./diff.ts";
import { fileSearchValue } from "./file-search.ts";
import { insertValue } from "./insert.ts";
import { lspSearchValue } from "./lsp-search.ts";
import { moveValue } from "./move.ts";
import { readValue } from "./read.ts";
import { replaceValue } from "./replace.ts";
import { searchValue } from "./search.ts";
import { semanticSearchValue } from "./semantic-search.ts";
import { terminalValue } from "./terminal.ts";
import { textValue } from "./text.ts";
import type { ScriptValue } from "./types.ts";
import { undoValue } from "./undo.ts";
import { writeValue } from "./write.ts";

export type { ScriptValue, ScriptValueInput } from "./types.ts";

/** IDE tools with their own Codemode value. Every other IDE tool resolves to its result string. */
const values: Readonly<Record<string, ScriptValue>> = {
  read: readValue,
  search: searchValue,
  ast_search: astSearchValue,
  lsp_search: lspSearchValue,
  file_search: fileSearchValue,
  semantic_search: semanticSearchValue,
  replace: replaceValue,
  insert: insertValue,
  delete: deleteValue,
  write: writeValue,
  copy: copyValue,
  move: moveValue,
  undo: undoValue,
  diff: diffValue,
  bash: terminalValue,
  powershell: terminalValue,
  remote_bash: terminalValue,
  remote_powershell: terminalValue,
};

/** The Codemode value of an IDE tool: its own module's value, or its readable string. */
export function scriptValueOf(tool: string): ScriptValue {
  return values[tool] ?? textValue;
}

/** The declared `outputSchema`: the tool's value, or `null` when the call failed. */
export function nullableValueSchema(value: ScriptValue): Record<string, unknown> {
  const anyOf = value.schema.anyOf;
  const variants: readonly unknown[] = Array.isArray(anyOf) ? anyOf : [value.schema];
  return { anyOf: [...variants, { type: "null" }] };
}
