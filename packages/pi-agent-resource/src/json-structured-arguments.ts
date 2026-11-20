import { lstatSync } from "node:fs";
import path from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

interface InputSchema {
  readonly type?: unknown;
  readonly anyOf?: readonly InputSchema[];
  readonly oneOf?: readonly InputSchema[];
  readonly properties?: Readonly<Record<string, InputSchema>>;
  readonly items?: InputSchema;
}

/** Context required to recover structured source arguments without hiding literal paths. */
export interface StructuredSourceContext {
  readonly cwd: string;
  readonly sourceFields: readonly string[];
  /** Resolve issued values with the caller's registry, rejecting unknown IDs and metadata. */
  readonly resolveSource: (value: unknown) => unknown;
}

function branches(schema: InputSchema): readonly InputSchema[] {
  return schema.anyOf?.flatMap(branches) ?? schema.oneOf?.flatMap(branches) ?? [schema];
}

function literalPathExists(value: string, cwd: string): boolean {
  try {
    lstatSync(path.resolve(cwd, value));
    return true;
  } catch (error) {
    // Inaccessible paths and broken symlinks must not redirect a call to decoded sources.
    const code = (error as NodeJS.ErrnoException).code;
    return !["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(code ?? "");
  }
}

function validSource(value: unknown, context: StructuredSourceContext): boolean {
  if (Array.isArray(value)) return value.every((item) => validSource(item, context));
  if (typeof value === "string") return true;
  if (
    value === null ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string"
  )
    return false;
  try {
    context.resolveSource(value);
    return true;
  } catch {
    return false;
  }
}

function normalize(
  input: unknown,
  schemas: readonly InputSchema[],
  context?: StructuredSourceContext,
  source = false,
): unknown {
  let value = input;
  const alternatives = schemas.flatMap(branches);
  if (typeof value === "string") {
    const permitsString = alternatives.some((schema) => schema.type === "string");
    // Selector and content strings never acquire structure from their spelling.
    if (permitsString && (!source || context === undefined)) return value;
    const first = value.trimStart()[0];
    const type = first === "{" ? "object" : first === "[" ? "array" : undefined;
    if (type === undefined || !alternatives.some((schema) => schema.type === type)) return value;
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return input;
    }
    if (permitsString && context !== undefined) {
      if (literalPathExists(input as string, context.cwd)) return input;
      const candidate = normalize(value, schemas, context, source);
      try {
        return validSource(candidate, context) &&
          Value.Check({ anyOf: alternatives } as TSchema, candidate)
          ? candidate
          : input;
      } catch {
        return input;
      }
    }
  }
  if (Array.isArray(value)) {
    const items = alternatives.flatMap((schema) =>
      schema.type === "array" && schema.items ? [schema.items] : [],
    );
    if (items.length === 0) return value;
    const normalized = value.map((item: unknown) => normalize(item, items, context, source));
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
      const field = normalize(
        object[key],
        properties,
        context,
        context?.sourceFields.includes(key),
      );
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

/** Decode composite-only slots and context-validated sources, preserving literal text and paths. */
export function normalizeStructuredArguments<T>(
  input: T,
  schema: TSchema,
  context?: StructuredSourceContext,
): T {
  return normalize(input, [schema], context) as T;
}
