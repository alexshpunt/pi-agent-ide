import type { TSchema } from "typebox";

/**
 * Stands in for an explicit `null` in a string field. Pi drops a null optional property before
 * `execute` runs, so a tool cannot tell it from an omitted field. `prepareArguments` swaps the
 * null for this string, which holds a NUL character that no path, glob or query can contain.
 */
export const NULL_FIELD = "\0null";

/**
 * `prepareArguments` for a search tool: keeps every explicit `null` argument visible to `execute`.
 *
 * A null in a field that takes a string becomes {@link NULL_FIELD}, and `execute` refuses it with
 * {@link nullFieldsMessage}. A null in another field, such as a number or a boolean, cannot pass
 * validation as a marker, so this throws: Pi reports it as invalid arguments.
 */
export function markNullFields(arguments_: unknown, schema: TSchema): unknown {
  if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_))
    return arguments_;
  const nulls = Object.entries(arguments_).filter(([, value]) => value === null);
  if (nulls.length === 0) return arguments_;
  const properties = (schema as { properties?: Record<string, TSchema> }).properties ?? {};
  const marked: Record<string, unknown> = { ...arguments_ };
  for (const [name] of nulls) {
    const property = properties[name];
    if (property === undefined || !acceptsString(property))
      throw new Error(
        `${name} is null. Omit ${name} instead; a null here usually means the call that produced it failed or selected no text.`,
      );
    marked[name] = NULL_FIELD;
  }
  return marked;
}

/** The refusal for the null fields of validated arguments, or `undefined` when none is null. */
export function nullFieldsMessage(
  parameters: Readonly<Record<string, unknown>>,
): string | undefined {
  const names = Object.entries(parameters)
    .filter(([, value]) => value === NULL_FIELD)
    .map(([name]) => name);
  if (names.length === 0) return undefined;
  const subject = names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`;
  return `${subject} null: the call that produced the value probably failed or selected no text. Omit the field to leave it unset; an omitted path searches the working directory.`;
}

function acceptsString(schema: TSchema): boolean {
  const { type, anyOf } = schema as { type?: unknown; anyOf?: TSchema[] };
  return type === "string" || (anyOf?.some(acceptsString) ?? false);
}
