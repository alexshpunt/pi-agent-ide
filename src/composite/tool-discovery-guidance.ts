import type {
  ExtensionAPI,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

type Tool = Pick<
  ReturnType<ExtensionAPI["getAllTools"]>[number],
  "name" | "exposure" | "namespace"
>;
interface ToolGuidance {
  names: string[];
  suffix: string;
}

export function getIdeToolGuidance(registered: readonly Tool[]): ToolGuidance[] {
  const tools = registered.filter((tool) => tool.exposure !== "hidden");
  const guidance: ToolGuidance[] = [];
  const add = (names: string[], suffix: string) => {
    if (names.length > 0) guidance.push({ names, suffix });
  };
  for (const [name, suffix] of [
    [
      "ast_search",
      " for structural code search: syntax patterns, captures and enclosing functions or classes.",
    ],
    [
      "lsp_search",
      " for navigation through language servers: symbol definitions, references and call graphs.",
    ],
    ["diff", " when comparing text sources."],
    ["undo", " when reverting the last text edit or an uncommitted Git change."],
  ] as const) {
    if (tools.some((tool) => tool.name === name)) add([name], suffix);
  }
  add(
    tools.filter((tool) => tool.namespace?.name === "ide_git").map((tool) => tool.name),
    " in ide_git when staging or unstaging selected Git changes.",
  );
  if (tools.some((tool) => tool.name === "debug" && tool.namespace?.name === "ide_debug"))
    add(["debug"], " in ide_debug when creating a debugger session.");
  return guidance;
}

export function buildIdeDiscoveryGuidance(
  tools: readonly Tool[],
  active: readonly string[],
  codemodeOnly: boolean,
): string {
  const guidance = getIdeToolGuidance(tools);
  const routes: string[] = [];
  const codemode = active.includes("codemode");
  if (codemode) {
    routes.push(
      "Inside Codemode, call known tools as tools.<name>(args), including deferred IDE tools. Find other tools with the script discovery functions in the Codemode description.",
    );
  }
  const hasDeferred = guidance.some(({ names }) => names.some((name) => !active.includes(name)));
  if (!(codemode && codemodeOnly) && hasDeferred) {
    if (active.includes("tool_search")) {
      routes.push("For direct calls, use tool_search to load tools not yet listed.");
    } else if (!codemode) {
      routes.push("Enable native tool_search to load deferred IDE tools.");
    }
  }
  return [
    ...routes,
    ...guidance.map(({ names, suffix }) => `Use ${names.join(" and ")}${suffix}`),
  ].join("\n");
}

/** Replace Pi's missing-member hint without changing the stack, output or call ledger. */
export function explainCodemodeDiscoveryError(
  event: ToolResultEvent,
): ToolResultEventResult | undefined {
  if (event.toolName !== "codemode" || !event.isError) return;
  const [header] = event.content;
  if (header?.type !== "text" || !header.text.startsWith("Script failed\n")) return;

  const marker = "Script error:\n";
  for (let index = event.content.length - 1; index > 0; index--) {
    const block = event.content[index];
    if (block?.type !== "text") continue;
    const error = block.text.lastIndexOf(marker);
    if (error === -1) continue;
    const start = error + marker.length;
    const remainder = block.text.slice(start);
    const corrected = remainder.replace(
      /^TypeError: tools\.tool_search does not exist\.[^\r\n]*/u,
      "TypeError: tool_search is for direct calls only. Replace tools.tool_search({ query, limit }) with searchTools(query, { limit }).",
    );
    if (corrected === remainder) return;
    const content = [...event.content];
    content[index] = { ...block, text: block.text.slice(0, start) + corrected };
    return { content };
  }
}
