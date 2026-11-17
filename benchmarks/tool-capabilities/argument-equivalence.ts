import { readFileSync } from "node:fs";
import { validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { normalizeStructuredArguments } from "pi-agent-resource/json-structured-arguments";

// The free inventory gate checks these structural schemas against the running IDE.
// Use Pi's parser, rather than approximating its coercion with Number()/parseInt().
const contracts = JSON.parse(
  readFileSync(new URL("./contracts.json", import.meta.url), "utf8"),
) as { tools: Tool[] };
const tools = new Map(contracts.tools.map((tool) => [tool.name, { ...tool, description: "" }]));

/** Standalone registrations share semantics and schemas, but keep distinct execution names. */
export function toolSemantics(name: string): string {
  return (
    /^(?:demo|other)_(read|search|write|replace|insert|delete|copy|move)$/u.exec(name)?.[1] ?? name
  );
}

/** Decode source forms independently of payload validation, including stream-guard cuts. */
export function sourceValues(input: unknown): string[] {
  const tool = tools.get("read");
  const value = tool ? normalizeStructuredArguments({ path: input }, tool.parameters).path : input;
  if (Array.isArray(value)) return (value as unknown[]).flatMap(sourceValues);
  if (value !== null && typeof value === "object" && "id" in value)
    return typeof value.id === "string" ? [value.id] : [];
  return typeof value === "string" ? [value] : [];
}

/** Compare executed arguments as Pi delivered them; leave retained evidence unchanged. */
export function executionArguments(
  name: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const tool = tools.get(toolSemantics(name));
  if (!tool || !args) return args;
  try {
    return validateToolArguments(tool, {
      type: "toolCall",
      id: "validation",
      name,
      arguments: normalizeStructuredArguments(args, tool.parameters) as ToolCall["arguments"],
    }) as Record<string, unknown>;
  } catch {
    // Intentional invalid-call routes must still see their original arguments.
    // A schema refusal grants no equivalence: compare the raw values strictly.
    return args;
  }
}
