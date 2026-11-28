import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  connectReadPlugin,
  READ_PROTOCOL,
  READ_API_VERSION,
  type ReadToolResult,
} from "pi-agent-ide/api/read";
import {
  connectSearchPlugin,
  SEARCH_PROTOCOL,
  SEARCH_API_VERSION,
  selectionData,
  type SearchSelectionMatch,
} from "pi-agent-ide/api/search";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_PROTOCOL,
  TEXT_EDITOR_API_VERSION,
} from "pi-agent-ide/api/text-editor";
import { type ResourceResolver } from "pi-agent-ide/api/resource";
import { connectAgentDocumentation } from "pi-agent-ide/api/documentation";
import { registerAgentIdeSettings, readAgentIdeSetting } from "pi-agent-ide/api/settings";
import {
  HerdrService,
  PROFILES,
  address,
  agentLine,
  failure,
  historyText,
  type RecoveryReceipt,
} from "./service.ts";
import { budgetValue, oneLine } from "./timeline.ts";
import { AgentWaiter, registerWaitForAgents } from "./wait.ts";
import { registerReplicate } from "./replicate.ts";
import { registerSubagent } from "./subagent.ts";
import { registerRecovery } from "./recovery.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function sourceOf(value: unknown): string | undefined {
  const path = record(value)?.path;
  return typeof path === "string" && path.startsWith("herdr:") ? path : undefined;
}
function textResult(
  source: string,
  text: string,
  startLine = 1,
  endLine = startLine + text.split("\n").length - 1,
  receipts: RecoveryReceipt[] = [],
): ReadToolResult {
  const details = { source, resolvedBy: "herdr", startLine, endLine, herdrReceipts: receipts };
  return {
    content: [{ type: "text", text }],
    // A history page has no known total. Native text avoids inventing an EOF for a partial page.
    script: { kind: "native", source, blocks: [{ type: "text", text }] },
    details,
  };
}

export default async function herdrExtension(pi: ExtensionAPI): Promise<void> {
  let owner = "unstarted";
  pi.on("session_start", (_event, context) => {
    owner = context.sessionManager.getSessionId();
  });
  pi.on("session_shutdown", () => {
    owner = "stopped";
  });
  const service = new HerdrService(pi, () => owner);
  registerRecovery(pi);
  registerAgentIdeSettings(pi, "pi-agent-herdr", [
    {
      kind: "text",
      id: "herdr-read-budget",
      name: "Herdr read budget",
      description: "Timeline character ceiling, from 500 to 20000.",
      default: "3000",
      group: "features",
    },
  ]);
  connectAgentDocumentation(pi, [
    {
      id: "herdr",
      description: "Herdr agent resources, history and coordination messages.",
      markdown: await readFile(
        path.join(path.dirname(import.meta.dirname), "docs/herdr.md"),
        "utf8",
      ),
      triggers: [
        ...["read", "search", "write", "delete"].map((tool) => ({
          tool,
          resourcePrefixes: ["herdr:"],
        })),
        { tool: "replicate" },
        { tool: "subagent" },
      ],
    },
  ]);
  const defaultBudget = async (cwd: string) =>
    budgetValue((await readAgentIdeSetting(pi.events, "herdr-read-budget", cwd)).value);
  const waiter = new AgentWaiter(service, defaultBudget);
  registerWaitForAgents(pi, waiter);
  const replicas = registerReplicate(pi, waiter, () => owner);
  registerSubagent(pi, replicas, () => owner);
  const inputResolver: ResourceResolver = {
    id: "herdr-input",
    async tryResolve(source) {
      if (!source.startsWith("herdr:")) return { kind: "not-handled" };
      return {
        kind: "resolved",
        resource: {
          source,
          skipPostEdit: true,
          async read() {
            return [{ type: "text", text: "Herdr message destination" }];
          },
        },
      };
    },
  };
  await Promise.all([
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: "herdr",
      setup(api) {
        const readReceipts = new WeakMap<object, RecoveryReceipt[]>();
        api.addView({
          view: "budget",
          contentKind: "any",
          presenter: { id: "herdr-budget", present: (document) => document },
        });
        api.addResolver({
          priority: -200,
          resolver: {
            id: "herdr",
            async tryResolve(source, context) {
              if (!source.startsWith("herdr:")) return { kind: "not-handled" };
              const receipts: RecoveryReceipt[] = [];
              readReceipts.set(context, receipts);
              return {
                kind: "resolved",
                resource: {
                  source,
                  async read() {
                    return [
                      {
                        type: "text",
                        text: await service.read(
                          source,
                          await defaultBudget(context.cwd),
                          receipts,
                        ),
                      },
                    ];
                  },
                },
              };
            },
          },
        });
        api.addHandler({
          stage: "pre-read",
          async handler(context) {
            const source = context.request.path;
            if (!source?.startsWith("herdr:")) return { kind: "continue", context };
            try {
              const target =
                source === "herdr:" || source === PROFILES ? undefined : address(source);
              const views = context.request.views ?? [];
              const budgetViews = views.filter(
                (view) => view === "budget" || view.startsWith("budget:"),
              );
              if (budgetViews.length > 1)
                throw failure("HERDR_INVALID_BUDGET", source, "Supply one budget:<chars> view.");
              if (target?.history) {
                const receipts: RecoveryReceipt[] = [];
                if (budgetViews.length)
                  throw failure(
                    "UNSUPPORTED_OPERATION",
                    source,
                    "The budget view applies to agent timelines.",
                  );
                const limit = Math.min(50, context.request.limit ?? 20);
                const offset = context.request.offset;
                if (
                  !Number.isSafeInteger(limit) ||
                  limit < 1 ||
                  (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 1))
                )
                  throw failure(
                    "HERDR_INVALID_RANGE",
                    source,
                    "Use a positive history item offset and a limit from 1 to 50.",
                  );
                const items = await service.history(
                  source,
                  {
                    limit,
                    ...(offset === undefined ? {} : { before: offset - 1 + limit }),
                  },
                  receipts,
                );
                const page =
                  offset === undefined ? items : items.filter((item) => item.index >= offset - 1);
                return {
                  kind: "return",
                  result: textResult(
                    source,
                    historyText(page),
                    (page.at(0)?.index ?? (offset ?? 1) - 1) + 1,
                    (page.at(-1)?.index ?? (offset ?? 1) - 1) + 1,
                    receipts,
                  ),
                };
              }
              if (!budgetViews.length) return { kind: "continue", context };
              if (!target)
                throw failure(
                  "UNSUPPORTED_OPERATION",
                  source,
                  "The budget view applies to one agent timeline.",
                );
              const budget = budgetValue(budgetViews[0].slice("budget:".length));
              const receipts: RecoveryReceipt[] = [];
              const text = await service.read(source, budget, receipts);
              return {
                kind: "return",
                result: textResult(source, text, 1, text.split("\n").length, receipts),
              };
            } catch (error) {
              return {
                kind: "return",
                result: {
                  content: [
                    { type: "text", text: error instanceof Error ? error.message : String(error) },
                  ],
                  details: { source, resolvedBy: "herdr" },
                  isError: true,
                },
              };
            }
          },
        });
        api.addHandler({
          stage: "post-read",
          async handler(context) {
            const receipts = readReceipts.get(context.resolverContext);
            if (!receipts?.length) return { kind: "continue", context };
            return {
              kind: "continue",
              context,
              transform: (result) =>
                result.isError
                  ? result
                  : {
                      ...result,
                      details: { ...result.details, herdrReceipts: receipts },
                    },
            };
          },
        });
        api.describe({
          path: "Read herdr: to list independent agents, or herdr:<terminal> for a timeline. Read herdr:<terminal>/history at a Search match line number. Read herdr:profiles for the workflow profiles that select an agent's model.",
          views: "Use budget:<chars> on a Herdr timeline to override its character ceiling.",
        });
      },
    }),
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "herdr",
      setup(api) {
        api.addResolver({
          priority: -200,
          resolver: {
            id: "herdr",
            readResources: (request) => (request.path?.startsWith("herdr:") ? [request.path] : []),
            async tryResolve(request) {
              const source = request.path;
              if (!source?.startsWith("herdr:")) return { kind: "not-handled" };
              try {
                if (request.query.startsWith("regex:") || request.wholeWord || request.multiline)
                  throw failure(
                    "HERDR_LITERAL_ONLY",
                    source,
                    "Herdr history supports literal substring queries only. Omit wholeWord and multiline.",
                  );
                let query = request.query;
                if (query.startsWith('"') && query.endsWith('"')) query = query.slice(1, -1);
                if (query.length > 200)
                  throw failure(
                    "HERDR_INVALID_QUERY",
                    source,
                    "Use a literal query of at most 200 characters.",
                  );
                const limit = Math.min(50, request.limit ?? 20);
                const fold = (value: string) =>
                  request.caseSensitive ? value : value.toLowerCase();
                const matches: SearchSelectionMatch[] = [];
                const receipts: RecoveryReceipt[] = [];
                if (source === "herdr:") {
                  const agents = await service.list(true, receipts);
                  for (const [index, agent] of agents.entries()) {
                    const lineText = agentLine(agent);
                    const startColumn = fold(lineText).indexOf(fold(query));
                    if (startColumn >= 0 && matches.length < limit)
                      matches.push({
                        source,
                        lineNumber: index + 1,
                        startColumn,
                        endColumn: startColumn + query.length,
                        matchedText: lineText.slice(startColumn, startColumn + query.length),
                        lineText,
                      });
                  }
                } else {
                  const target = address(source);
                  if (!target)
                    throw failure("HERDR_INVALID_ADDRESS", source, "Use a Herdr agent address.");
                  const items = await service.history(
                    source,
                    {
                      query,
                      caseSensitive: request.caseSensitive ?? false,
                      limit,
                    },
                    receipts,
                  );
                  for (const item of items) {
                    const lineText = oneLine(item.text),
                      startColumn = Math.max(0, fold(lineText).indexOf(fold(query)));
                    matches.push({
                      source: `herdr:${target.terminal}/history`,
                      lineNumber: item.index + 1,
                      startColumn,
                      endColumn: startColumn + query.length,
                      matchedText: query,
                      lineText,
                    });
                  }
                }
                return {
                  kind: "resolved",
                  payload: { source, matches, complete: false, receipts },
                };
              } catch (error) {
                return { kind: "failed", error };
              }
            },
            toScriptData(payload) {
              const value = payload as { matches: SearchSelectionMatch[] };
              return selectionData(value.matches, false);
            },
            format(payload) {
              const value = payload as {
                source: string;
                matches: SearchSelectionMatch[];
                receipts: RecoveryReceipt[];
              };
              return {
                content: [
                  {
                    type: "text",
                    text:
                      value.matches
                        .map((match) => `${match.source}:${match.lineNumber}: ${match.lineText}`)
                        .join("\n") || "No matches.",
                  },
                ],
                details: { source: value.source, payload: value, herdrReceipts: value.receipts },
              };
            },
          },
        });
        api.describe(
          "Search herdr: for agent names and terminals, or herdr:<terminal> for literal matches throughout its session branch.",
        );
      },
    }),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "herdr",
      setup(api) {
        api.addResolver({ resolver: inputResolver, priority: -200 });
        api.tool("write").addSemanticHandler({
          matches: (value) => sourceOf(value) !== undefined,
          async execute(_context, value) {
            const input = record(value),
              source = sourceOf(value);
            if (!input || !source)
              throw failure("HERDR_INVALID_ADDRESS", "herdr:", "Use a Herdr agent address.");
            if (
              typeof input.content !== "string" ||
              ["start", "end", "image"].some((key) => input[key] !== undefined)
            )
              throw failure(
                "HERDR_INVALID_MESSAGE",
                source,
                "Write a plain text message with path and content.",
              );
            const receipts: RecoveryReceipt[] = [];
            await service.send(source, input.content, receipts);
            return {
              source,
              summary: `Message sent to ${source}.`,
              data: { kind: "herdr-message", effect: "applied", herdrReceipts: receipts },
              script: { source },
            };
          },
        });
        api.tool("delete").addSemanticHandler({
          matches: (value) => sourceOf(value) !== undefined,
          async execute(_context, value) {
            const input = record(value),
              source = sourceOf(value);
            if (!input || !source)
              throw failure("HERDR_INVALID_ADDRESS", "herdr:", "Use a Herdr agent address.");
            if (["start", "end"].some((key) => input[key] !== undefined))
              throw failure(
                "UNSUPPORTED_OPERATION",
                source,
                "Delete herdr:<terminal> with path alone.",
              );
            const receipts: RecoveryReceipt[] = [];
            await service.remove(source, receipts);
            const target = address(source);
            if (target) replicas.closed(target.terminal);
            return {
              source,
              summary: `Closed ${source} and its tab.`,
              data: {
                kind: "herdr-agent",
                deleted: true,
                effect: "applied",
                herdrReceipts: receipts,
              },
              script: { source },
            };
          },
        });
        for (const tool of ["replace", "insert", "move", "copy"] as const)
          api.tool(tool).addSemanticHandler({
            matches: (value) => {
              const target = record(value)?.target;
              return (
                sourceOf(value) !== undefined ||
                (typeof target === "string" && target.startsWith("herdr:"))
              );
            },
            execute(_context, value) {
              const source = sourceOf(value) ?? String(record(value)?.target);
              throw failure(
                "UNSUPPORTED_OPERATION",
                source,
                "Use write to send a message to herdr:<terminal>, or delete to close the agent.",
              );
            },
          });
        api.describe(
          "Write to herdr:<terminal> to send a steering message; delete it to close the agent and its tab. Read the target first in this session.",
        );
      },
    }),
  ]);
}
