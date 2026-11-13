import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Tool = Pick<
  ReturnType<ExtensionAPI["getAllTools"]>[number],
  "name" | "exposure" | "namespace"
>;
type Discovery = "tool_search" | "codemode" | "enable_tool_search";

interface ToolGuidance {
  names: string[];
  discovery?: Discovery;
  suffix: string;
}

export function getIdeToolGuidance(
  registered: readonly Tool[],
  active: readonly string[],
): ToolGuidance[] {
  const tools = registered.filter((tool) => tool.exposure !== "hidden");
  const discovery: Discovery = active.includes("tool_search")
    ? "tool_search"
    : active.includes("codemode")
      ? "codemode"
      : "enable_tool_search";
  const activeNames = new Set(active);
  const guidance: ToolGuidance[] = [];
  const add = (names: string[], suffix: string) => {
    for (const isActive of [true, false]) {
      const group = names.filter((name) => activeNames.has(name) === isActive);
      if (group.length > 0)
        guidance.push({ names: group, discovery: isActive ? undefined : discovery, suffix });
    }
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
): string {
  const prefixes = {
    tool_search: "Use tool_search to find",
    codemode: "Use searchTools inside codemode to find",
    enable_tool_search: "Enable native tool_search to find",
  };
  const guidance = getIdeToolGuidance(tools, active);
  const reminder = guidance.some((entry) => entry.discovery !== undefined)
    ? [
        "Call tools in your tool list directly; follow discovery guidance only for tools not listed.",
      ]
    : [];
  return [
    ...reminder,
    ...guidance.map(
      ({ names, discovery, suffix }) =>
        `${discovery === undefined ? "Use" : prefixes[discovery]} ${names.join(" and ")}${suffix}`,
    ),
  ].join("\n");
}
