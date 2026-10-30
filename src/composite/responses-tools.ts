function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relaxed(tools: readonly unknown[], names: ReadonlySet<string>): readonly unknown[] {
  const next = tools.map((tool) => {
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
  return next.some((tool, index) => tool !== tools[index]) ? next : tools;
}

/** Opt IDE declarations in both Responses tool locations out of implicit strictness. */
export function preserveResponsesToolOmission(
  payload: unknown,
  names: ReadonlySet<string>,
): unknown {
  if (!isRecord(payload)) return payload;
  let next = payload;
  if (Array.isArray(payload.tools)) {
    const tools = relaxed(payload.tools, names);
    if (tools !== payload.tools) next = { ...next, tools };
  }
  const original = payload.input;
  if (Array.isArray(original)) {
    const input = original.map((item: unknown) => {
      if (!isRecord(item) || item.type !== "additional_tools" || !Array.isArray(item.tools))
        return item;
      const tools = relaxed(item.tools, names);
      return tools === item.tools ? item : { ...item, tools };
    });
    if (input.some((item, index) => item !== original[index])) next = { ...next, input };
  }
  return next;
}
