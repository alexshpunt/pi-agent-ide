import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Copy each tool result's details and structured content before Pi keeps them for the rest of the
 * session.
 *
 * A short string cut from a larger one, such as a line or a match taken from a file, shares the
 * larger string's memory in V8. Pi keeps every result in the session history and the transcript,
 * so one kept line would keep its whole file in memory for every result. The copy holds only the
 * text it shows.
 *
 * Only plain objects, arrays and strings are copied. Class instances and functions stay the same
 * values: result handlers of extensions loaded after the IDE still see them, for example a
 * `ResourceError` in a Read failure, which a structured clone would turn into a plain `Error`.
 */
export function registerDetachedResults(pi: Pick<ExtensionAPI, "on">): void {
  pi.on("tool_result", (event) => {
    const details = detached(event.details);
    const structuredContent = detached(event.structuredContent);
    if (details === undefined && structuredContent === undefined) return;
    return {
      ...(details !== undefined && { details: details.value }),
      ...(structuredContent !== undefined && { structuredContent: structuredContent.value }),
    };
  });
}

function detached<T>(value: T): { readonly value: T } | undefined {
  if (value === undefined || value === null) return undefined;
  return { value: copy(value, new Map()) as T };
}

function copy(value: unknown, copies: Map<object, unknown>): unknown {
  // Serializing a string writes its characters into a new string that shares no memory.
  if (typeof value === "string") return structuredClone(value);
  if (value === null || typeof value !== "object") return value;
  const existing = copies.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    copies.set(value, items);
    for (const item of value) items.push(copy(item, copies));
    return items;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return value;
  const fields = (prototype === null ? Object.create(null) : {}) as Record<string, unknown>;
  copies.set(value, fields);
  for (const [key, field] of Object.entries(value)) fields[key] = copy(field, copies);
  return fields;
}
