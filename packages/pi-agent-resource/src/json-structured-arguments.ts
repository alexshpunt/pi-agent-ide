import type { TSchema } from "typebox";

interface InputSchema {
  readonly type?: unknown;
  readonly anyOf?: readonly InputSchema[];
  readonly oneOf?: readonly InputSchema[];
  readonly properties?: Readonly<Record<string, InputSchema>>;
  readonly items?: InputSchema;
}

function branches(schema: InputSchema): readonly InputSchema[] {
  return schema.anyOf?.flatMap(branches) ?? schema.oneOf?.flatMap(branches) ?? [schema];
}

function normalize(input: unknown, schemas: readonly InputSchema[]): unknown {
  let value = input;
  const alternatives = schemas.flatMap(branches);
  if (typeof value === "string") {
    const first = value.trimStart()[0];
    const type = first === "{" ? "object" : first === "[" ? "array" : undefined;
    if (type === undefined || !alternatives.some((schema) => schema.type === type)) return value;
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      // A malformed JSON-looking source or selector is still ordinary string input.
      return input;
    }
  }
  if (Array.isArray(value)) {
    const items = alternatives.flatMap((schema) =>
      schema.type === "array" && schema.items ? [schema.items] : [],
    );
    if (items.length === 0) return value;
    const normalized = value.map((item: unknown) => normalize(item, items));
    return normalized.some((item, index) => item !== value[index]) ? normalized : value;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    let normalized = object;
    for (const key of Object.keys(object)) {
      const properties = alternatives.flatMap((schema) =>
        schema.type === "object" && schema.properties?.[key] ? [schema.properties[key]] : [],
      );
      if (properties.length === 0) continue;
      const field = normalize(object[key], properties);
      if (field === object[key]) continue;
      if (normalized === object) normalized = { ...object };
      Object.defineProperty(normalized, key, {
        value: field,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return normalized;
  }
  return value;
}

/** Decode JSON text only in schema-declared object/array positions; leave validation to Pi. */
export function normalizeStructuredArguments<T>(input: T, schema: TSchema): T {
  return normalize(input, [schema]) as T;
}
