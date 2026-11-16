import { readFileSync } from "node:fs";
import { validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { normalizeStructuredArguments } from "pi-agent-resource/json-structured-arguments";

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
  // The standalone fixture registers these namespaces with the same shared tool schemas.
  // This selects a parser only; route matching still checks the original execution name.
  const standaloneTool =
    /^(?:demo|other)_(read|search|write|replace|insert|delete|copy|move)$/u.exec(name)?.[1];
  const tool = tools.get(standaloneTool ?? name);
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
