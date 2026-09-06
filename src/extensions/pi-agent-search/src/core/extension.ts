import {
  type AgentToolResult,
  type ExtensionAPI,
  keyText,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import {
  toolCallHeader,
  type ToolCallHeaderDetail,
  type ToolCallHeaderModel,
} from "pi-agent-tool-ui";

import os from "node:os";
import {
  ToolCallInterceptionRenderStore,
  withToolCallInterceptionRendering,
} from "pi-agent-tool-call-interception";
import { type Static, Type } from "typebox";

import {
  isSearchPluginRegistrationRequest,
  SEARCH_API_VERSION,
  SEARCH_CORE_READY_EVENT,
  SEARCH_PLUGIN_REGISTER_EVENT,
  SEARCH_PROTOCOL,
} from "#src/api/plugin-protocol.js";
import { createSearchCore } from "#src/core/search-core.js";

import { loadSearchConfig, resolveSearchConfigPaths } from "#src/core/search-config.js";
import { runWithSearchTimeout } from "#src/core/search-timeout.js";

import type { SearchToolDetails } from "#src/api/search.js";

const searchSchema = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      description:
        "Search query. Local text tries literal terms, then regex, then eligible word fallback. Quotes keep terms literal and Boolean conditions stay intact. Empty or unhandled prefixes are text; nonempty installed prefixes select specialized search protocols.",
    }),
    path: Type.Optional(
      Type.String({ description: "Optional file or directory scope for local search" }),
    ),
    include: Type.Optional(Type.String({ description: "Optional include glob for local search" })),
    exclude: Type.Optional(Type.String({ description: "Optional exclude glob for local search" })),
    caseSensitive: Type.Optional(
      Type.Boolean({ description: "Match letter case in local search" }),
    ),
    wholeWord: Type.Optional(Type.Boolean({ description: "Match complete words in local search" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum results (default 100)" }),
    ),
  },
  { additionalProperties: false },
);

/** Arguments accepted by the search tool. */
export type SearchParameters = Static<typeof searchSchema>;

/** Builds the width-independent search call presentation. */
export function searchCallModel(
  arguments_: SearchParameters,
  expanded: boolean,
): ToolCallHeaderModel {
  const qualifiers = [
    ...(arguments_.path === undefined
      ? []
      : [
          {
            text: `in ${arguments_.path}`,
            color: "accent" as const,
            underline: true,
            truncate: "start" as const,
          },
        ]),
    ...(arguments_.include === undefined ? [] : [{ text: `include ${arguments_.include}` }]),
    ...(arguments_.exclude === undefined ? [] : [{ text: `exclude ${arguments_.exclude}` }]),
    ...(arguments_.caseSensitive === true ? [{ text: "case sensitive" }] : []),
    ...(arguments_.wholeWord === true ? [{ text: "whole word" }] : []),
    ...(arguments_.limit === undefined ? [] : [{ text: `limit ${String(arguments_.limit)}` }]),
  ];
  return {
    tool: "search",
    primary: {
      text: JSON.stringify(arguments_.query),
      color: "accent",
      truncate: "end",
    },
    qualifiers,
    details: searchCallDetails(arguments_),
    expanded,
  };
}

export default async function registerSearchCore(pi: ExtensionAPI): Promise<void> {
  const core = createSearchCore();
  const interceptionRendering = new ToolCallInterceptionRenderStore();
  const unsubscribe = pi.events.on(SEARCH_PLUGIN_REGISTER_EVENT, (request) => {
    if (!isSearchPluginRegistrationRequest(request)) {
      throw new Error("Invalid pi-agent-search plugin registration request");
    }

    request.accept(core.registerPlugin(request.plugin));
  });
  pi.on("session_shutdown", unsubscribe);
  pi.registerTool(
    withToolCallInterceptionRendering(
      {
        name: "search",
        label: "search",
        description:
          "Search workspace text and paths through installed local, language, and structural search protocols.",
        promptSnippet:
          "Search files and text with literals or regular expressions, plus syntax trees and language symbols",
        get promptGuidelines(): string[] {
          return [
            "Use search instead of grep, rg, or find to search workspace text and paths.",
            "Use the narrowest useful search query and scope; broaden when needed.",
            "Do not use search merely to rediscover a file path already named in the request; use that path directly. Search within it only when you need to locate content.",
            ...core.renderPromptGuidelines(),
          ];
        },
        parameters: searchSchema,
        renderCall(arguments_, theme, context): Component {
          return toolCallHeader(
            context.lastComponent,
            searchCallModel(arguments_, context.expanded),
            theme,
          );
        },
        renderResult(result, options, theme, context): Component {
          const details = result.details as SearchToolDetails | undefined;
          const renderer =
            details?.resolverId === undefined ? undefined : core.renderer(details.resolverId);

          if (renderer !== undefined) {
            const inner = { ...result, details: details?.payload };
            return renderer(inner, options, theme, context);
          }

          return fallbackResult(result, options, theme);
        },
        async execute(
          _id,
          parameters: SearchParameters,
          signal,
          onUpdate,
          context,
        ): Promise<AgentToolResult<SearchToolDetails>> {
          const config = await loadSearchConfig(
            resolveSearchConfigPaths(process.env, os.homedir(), context.cwd),
          );
          return runWithSearchTimeout(config.timeoutMs, signal, async (operationSignal) => {
            await core.waitForPendingPlugins();
            return core.execute(parameters, {
              cwd: context.cwd,
              ...(operationSignal !== undefined && { signal: operationSignal }),
              ...(onUpdate !== undefined && {
                onUpdate: (update) => {
                  onUpdate(update);
                },
              }),
            });
          });
        },
      },
      interceptionRendering,
    ),
  );
  pi.events.emit(SEARCH_CORE_READY_EVENT, {
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
  });
  await core.waitForPendingPlugins();
}

function searchCallDetails(arguments_: SearchParameters): ToolCallHeaderDetail[] {
  return [
    { label: "query", value: JSON.stringify(arguments_.query) },
    ...optionalDetail("path", arguments_.path),
    ...optionalDetail("include", arguments_.include),
    ...optionalDetail("exclude", arguments_.exclude),
    ...optionalDetail(
      "caseSensitive",
      arguments_.caseSensitive === undefined ? undefined : String(arguments_.caseSensitive),
    ),
    ...optionalDetail(
      "wholeWord",
      arguments_.wholeWord === undefined ? undefined : String(arguments_.wholeWord),
    ),
    ...optionalDetail(
      "limit",
      arguments_.limit === undefined ? undefined : String(arguments_.limit),
    ),
  ];
}

function optionalDetail(label: string, value: string | undefined): ToolCallHeaderDetail[] {
  return value === undefined ? [] : [{ label, value }];
}

function fallbackResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  const preview = options.expanded ? text : text.split("\n").slice(0, 8).join("\n");
  const hint =
    !options.expanded && text.split("\n").length > 8
      ? `\n${theme.fg("dim", `${keyText("app.tools.expand")} to expand`)}`
      : "";
  return new Text(`${theme.fg("muted", preview)}${hint}`, 0, 0);
}
