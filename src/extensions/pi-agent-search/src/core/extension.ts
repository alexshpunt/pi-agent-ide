import {
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";
import {
  ResultPanel,
  toolCallHeader,
  type ToolCallHeaderDetail,
  type ToolCallHeaderModel,
} from "pi-agent-tool-ui";

import os from "node:os";
import {
  ToolCallInterceptionRenderStore,
  withToolCallInterceptionRendering,
} from "pi-agent-tool-call-interception";
import type { Static } from "typebox";

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

import { searchSchema } from "#src/api/search-parameters.js";
import { searchOutputSchema, searchDataSchema } from "#src/api/structured-result.js";
import { connectResultTargets, resultError, withStructuredResult } from "pi-agent-resource";

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
            text: typeof arguments_.path === "string" ? `in ${arguments_.path}` : "in result scope",
            color: "accent" as const,
            underline: true,
            truncate: "start" as const,
          },
        ]),
    ...(arguments_.navigation === undefined
      ? []
      : [{ text: "reference navigation", color: "warning" as const }]),
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

function parsePresentation(value: string | undefined): "full" | "compact" | "disabled" {
  return value === "full" || value === "disabled" ? value : "compact";
}
export default async function registerSearchCore(
  pi: ExtensionAPI,
  context?: { readonly preferences: Readonly<Record<string, string>> },
): Promise<void> {
  const presentation = parsePresentation(context?.preferences["ui.search"]);
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "search-code",
      description: "Text search, AST patterns, symbols, graphs, and semantic rename",
      triggers: [
        { tool: "search" },
        { tool: "read", resourcePrefixes: ["ast:", "symbol:", "symbols:", "graph:"] },
      ],
    }),
  ]);
  const targets = connectResultTargets(pi);
  const core = createSearchCore(targets);
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
        exposure: "direct",
        namespace: {
          name: "ide_search",
          description: "Find workspace text, paths and code structures.",
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        label: "search",
        description:
          "Use search to find text, file paths, syntax patterns, language symbols, web-page text, and running processes.",
        promptSnippet:
          "Search files and text with literals or regular expressions, plus syntax trees and language symbols",
        get promptGuidelines(): string[] {
          return [
            "Use the narrowest useful search query and scope; broaden when needed.",
            ...core.renderPromptGuidelines(),
          ];
        },
        parameters: searchSchema,
        outputSchema: searchOutputSchema,
        renderCall(arguments_, theme, renderContext): Component {
          const mode = renderContext.expanded ? "full" : presentation;
          if (mode === "disabled") return new Text(theme.fg("toolTitle", "search"), 0, 0);
          return toolCallHeader(
            renderContext.lastComponent,
            searchCallModel(arguments_, mode === "full"),
            theme,
          );
        },
        renderResult(result, options, theme, context): Component {
          const mode = options.expanded ? "full" : presentation;
          if (mode === "disabled" && !context.isError && !options.isPartial)
            return new Text(theme.fg("success", "✓ search"), 0, 0);
          options = { ...options, expanded: mode === "full" };
          const details = result.details as SearchToolDetails | undefined;
          const renderer =
            details?.resolverId === undefined ? undefined : core.renderer(details.resolverId);

          if (
            renderer !== undefined &&
            details?.payload !== undefined &&
            !context.isError &&
            !options.isPartial
          ) {
            const inner = { ...result, details: details.payload };
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
          try {
            const config = await loadSearchConfig(
              resolveSearchConfigPaths(process.env, os.homedir(), context.cwd),
            );
            return await runWithSearchTimeout(config.timeoutMs, signal, async (operationSignal) => {
              await core.waitForPendingPlugins();
              const scoped =
                parameters.path !== undefined &&
                (typeof parameters.path !== "string" || parameters.path.startsWith("RESULT#"));
              const scope = scoped ? targets.resolve(parameters.path, context.cwd) : undefined;
              if (scope !== undefined) {
                await targets.verify(scope, operationSignal);
                if (/^(?:files|symbol|graph|process):/u.test(parameters.query))
                  throw new Error("This query provider does not support result scopes yet.");
              }
              return core.execute(
                {
                  ...parameters,
                  path:
                    typeof parameters.path === "string" && !scoped ? parameters.path : undefined,
                },
                {
                  cwd: context.cwd,
                  ...(scope === undefined ? {} : { scope }),
                  ...(operationSignal !== undefined && { signal: operationSignal }),
                  ...(onUpdate !== undefined && { onUpdate }),
                },
              );
            });
          } catch (error) {
            if (signal?.aborted) throw error;
            const message = error instanceof Error ? error.message : String(error);
            return withStructuredResult(
              {
                content: [{ type: "text", text: message }],
                details: { failure: { code: "RESOLVE_FAILED", message } },
              },
              searchDataSchema,
              {
                status: "error",
                errors: [resultError(error, "SEARCH_FAILED")],
              },
            );
          }
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
    ...optionalDetail(
      "path",
      arguments_.path === undefined
        ? undefined
        : typeof arguments_.path === "string"
          ? arguments_.path
          : "result scope",
    ),
    ...optionalDetail("navigation", arguments_.navigation),
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
  return new ResultPanel(
    {
      summary:
        result.details && typeof result.details === "object" && "failure" in result.details
          ? "Search failed"
          : "Search results",
      rows: text.split("\n").map((line) => ({ kind: "note", text: line })),
    },
    theme,
    options.expanded,
  );
}
