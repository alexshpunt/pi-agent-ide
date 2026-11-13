import {
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
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
} from "#src/api/plugin-protocol.ts";
import { createSearchCore } from "#src/core/search-core.ts";
import {
  describePathArgument,
  isNullScope,
  markNullScope,
  nullScopeMessage,
  plainPathList,
} from "#src/api/path-list.ts";

import { loadSearchConfig, resolveSearchConfigPaths } from "#src/core/search-config.ts";
import { runWithSearchTimeout } from "#src/core/search-timeout.ts";

import type { SearchToolDetails } from "#src/api/search.ts";

import { describeSearchParameters, type searchSchema } from "#src/api/search-parameters.ts";
import { searchOutputSchema, searchDataSchema } from "#src/api/structured-result.ts";
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
            text: `in ${describePathArgument(arguments_.path)}`,
            color: "accent" as const,
            underline: true,
            truncate: "start" as const,
          },
        ]),
    ...(arguments_.include === undefined ? [] : [{ text: `include ${arguments_.include}` }]),
    ...(arguments_.exclude === undefined ? [] : [{ text: `exclude ${arguments_.exclude}` }]),
    ...(arguments_.caseSensitive === true ? [{ text: "case sensitive" }] : []),
    ...(arguments_.wholeWord === true ? [{ text: "whole word" }] : []),
    ...(arguments_.multiline === true ? [{ text: "multiline" }] : []),
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
  const presentation = () => parsePresentation(context?.preferences["ui.search"]);
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
        description: "Use search to find text in files, web pages, guides and terminal output.",
        promptSnippet: "Search file contents with literals or regular expressions",
        get promptGuidelines(): string[] {
          return [...core.renderPromptGuidelines()];
        },
        get parameters() {
          return describeSearchParameters(core.renderDescriptions());
        },
        outputSchema: searchOutputSchema,
        prepareArguments: (arguments_) => markNullScope(arguments_) as SearchParameters,
        renderCall(arguments_, theme, renderContext): Component {
          const mode = renderContext.expanded ? "full" : presentation();
          if (mode === "disabled") return new Text(theme.fg("toolTitle", "search"), 0, 0);
          return toolCallHeader(
            renderContext.lastComponent,
            searchCallModel(arguments_, mode === "full"),
            theme,
          );
        },
        renderResult(result, options, theme, context): Component {
          const mode = options.expanded ? "full" : presentation();
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
          if (isNullScope(parameters.path)) {
            return withStructuredResult(
              {
                content: [{ type: "text", text: nullScopeMessage }],
                details: { failure: { code: "INVALID_REQUEST", message: nullScopeMessage } },
              },
              searchDataSchema,
              {
                status: "error",
                errors: [resultError(new Error(nullScopeMessage), "SEARCH_FAILED")],
              },
            );
          }
          try {
            const config = await loadSearchConfig(
              resolveSearchConfigPaths(process.env, os.homedir(), context.cwd),
            );
            return await runWithSearchTimeout(config.timeoutMs, signal, async (operationSignal) => {
              await core.waitForPendingPlugins();
              // A list of plain paths goes to the core as it is; a list of results is a scope.
              const pathList =
                Array.isArray(parameters.path) && plainPathList(parameters.path) !== undefined;
              const scoped =
                parameters.path !== undefined &&
                !pathList &&
                (typeof parameters.path !== "string" || parameters.path.startsWith("RESULT#"));
              // Search only reads, so a result whose lines changed still selects the same region.
              const rescope = scoped
                ? (signal?: AbortSignal) =>
                    targets.resolveCurrent(parameters.path, context.cwd, signal)
                : undefined;
              const scope = rescope === undefined ? undefined : await rescope(operationSignal);
              return core.execute(
                {
                  ...parameters,
                  path:
                    pathList || (typeof parameters.path === "string" && !scoped)
                      ? parameters.path
                      : undefined,
                },
                {
                  cwd: context.cwd,
                  ...(scope === undefined || rescope === undefined ? {} : { scope, rescope }),
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
      arguments_.path === undefined ? undefined : describePathArgument(arguments_.path),
    ),
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
      "multiline",
      arguments_.multiline === undefined ? undefined : String(arguments_.multiline),
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
