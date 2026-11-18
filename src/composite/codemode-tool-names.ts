type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapField(record: RecordValue, key: string, map: (value: unknown) => unknown): RecordValue {
  const value = map(record[key]);
  return value === record[key] ? record : { ...record, [key]: value };
}

function mapArray(value: unknown, map: (item: unknown) => unknown): unknown {
  if (!Array.isArray(value)) return value;
  const next = value.map(map);
  return next.some((item, index) => item !== value[index]) ? next : value;
}

/** Visit declaration locations used by Pi's flat, function-wrapped, Google and Bedrock payloads.
 * Do not recursively walk arbitrary message content or parameter schemas. */
function mapDeclarations(payload: unknown, map: (tool: RecordValue) => RecordValue): unknown {
  if (!isRecord(payload)) return payload;
  const declaration = (value: unknown): unknown => {
    if (!isRecord(value)) return value;
    if (typeof value.name === "string") return map(value);
    let next = value;
    for (const key of ["function", "toolSpec"]) {
      next = mapField(next, key, (tool) => (isRecord(tool) ? map(tool) : tool));
    }
    return mapField(next, "functionDeclarations", (tools) => mapArray(tools, declaration));
  };
  const tools = (record: RecordValue) =>
    mapField(record, "tools", (value) => mapArray(value, declaration));
  let next = tools(payload);
  for (const key of ["config", "toolConfig"]) {
    next = mapField(next, key, (value) => (isRecord(value) ? tools(value) : value));
  }
  return mapField(next, "input", (value) =>
    mapArray(value, (item) =>
      isRecord(item) && item.type === "additional_tools" ? tools(item) : item,
    ),
  );
}

/** Compare actual provider declarations, without a provider/model-specific rename table. */
export function codemodeToolNameMappings(
  payload: unknown,
  names: ReadonlySet<string>,
): { displayed: string; canonical: string }[] {
  const mappings = new Map<string, { displayed: string; canonical: string }>();
  mapDeclarations(payload, (tool) => {
    if (typeof tool.name !== "string" || names.has(tool.name)) return tool;
    const displayed = tool.name;
    const matches = [...names].filter((name) => name.toLowerCase() === displayed.toLowerCase());
    const [canonical] = matches;
    if (matches.length === 1 && canonical) mappings.set(displayed, { displayed, canonical });
    return tool;
  });
  return [...mappings.values()];
}

/** Clarify script member names and model-only discovery in provider declarations. */
export function explainCodemodeToolNames(
  payload: unknown,
  names: ReadonlySet<string>,
  directOnlyDiscovery = false,
): unknown {
  const mappings = codemodeToolNameMappings(payload, names);
  if (!directOnlyDiscovery && mappings.length === 0) return payload;
  return mapDeclarations(payload, (tool) => {
    if (typeof tool.description !== "string") return tool;
    if (directOnlyDiscovery && tool.name === "tool_search")
      return { ...tool, description: `For direct calls only. ${tool.description}` };
    if (tool.name !== "codemode" || mappings.length === 0) return tool;
    return {
      ...tool,
      description: `${tool.description}\n\nUse these exact JavaScript members inside Codemode instead of the provider-facing tool names:\n${mappings.map(({ displayed, canonical }) => `${displayed} → tools.${canonical}`).join("\n")}`,
    };
  });
}
