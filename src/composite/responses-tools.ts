function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Opt IDE function tools out of implicit Responses strictness without changing their schemas. */
export function preserveResponsesToolOmission(
  payload: unknown,
  names: ReadonlySet<string>,
): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;
  const original = payload.tools;
  const tools = original.map((tool: unknown) => {
    if (
      !isRecord(tool) ||
      tool.type !== "function" ||
      typeof tool.name !== "string" ||
      !names.has(tool.name) ||
      tool.strict !== undefined
    )
      return tool;
    // Responses can make every optional property required when strict is omitted.
    return { ...tool, strict: false };
  });
  return tools.some((tool, index) => tool !== original[index]) ? { ...payload, tools } : payload;
}
