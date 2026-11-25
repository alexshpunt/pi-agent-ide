import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const searchTools = new Set(["search", "linear_search"]);
const invalidScope = /\bLINEAR_INVALID_SEARCH_SCOPE\b(?![A-Z_])/u;

const hint =
  "Linear object search takes a search term and a scope; the only scope parameter is `milestone` on " +
  "a project. It has no status, label or priority filter, so do not try other parameters. To list " +
  "tasks by status, label, assignee or priority, send one filtered GraphQL query and page through " +
  'it with its cursor: read docs:linear-discovery, section "List issues by status, label or ' +
  'priority". Never list tasks by reading identifiers one at a time.';

/** Tell an agent whose object search was refused how to list tasks by a filter instead. */
export function connectLinearSearchErrorGuidance(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (!event.isError || !searchTools.has(event.toolName)) return;
    const text = event.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
    if (!invalidScope.test(text)) return;
    return { content: [{ type: "text" as const, text: hint }, ...event.content] };
  });
}
