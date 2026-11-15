import { readFileSync } from "node:fs";
import { validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";

// The free inventory gate checks these structural schemas against the running IDE.
// Use Pi's parser, rather than approximating its coercion with Number()/parseInt().
const contracts = JSON.parse(
  readFileSync(new URL("./contracts.json", import.meta.url), "utf8"),
) as { tools: Tool[] };
const tools = new Map(contracts.tools.map((tool) => [tool.name, { ...tool, description: "" }]));

/** Compare executed arguments as Pi delivered them; leave retained evidence unchanged. */
export function executionArguments(
  name: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const tool = tools.get(name);
  if (!tool || !args) return args;
  try {
    return validateToolArguments(tool, {
      type: "toolCall",
      id: "validation",
      name,
      arguments: args as ToolCall["arguments"],
    }) as Record<string, unknown>;
  } catch {
    // Intentional invalid-call routes must still see their original arguments.
    // A schema refusal grants no equivalence: compare the raw values strictly.
    return args;
  }
}
