import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resultError, resultInputSchema, withStructuredResult } from "pi-agent-resource";
import {
  searchDataSchema,
  searchOutputSchema,
  type SearchPluginApi,
  type SearchResolver,
  type SearchToolDetails,
} from "pi-agent-search/api/search";
import {
  ToolCallInterceptionRenderStore,
  withToolCallInterceptionRendering,
} from "pi-agent-tool-call-interception";
import { ResultPanel, toolCallHeader } from "pi-agent-tool-ui";
import { Type, type Static } from "typebox";

import type { LspSearchOptions } from "./search-resolver.js";

export const lspSearchSchema = Type.Object(
  {
    query: Type.Optional(
      Type.String({ minLength: 1, description: "Symbol name to find in the workspace." }),
    ),
    declaration: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "file#selector, such as src/app.ts#App/start: returns that declaration as an editable selection.",
      }),
    ),
    calls: Type.Optional(
      Type.String({
        minLength: 1,
        description: "file or file#selector: references and incoming/outgoing calls.",
      }),
    ),
    path: Type.Optional(
      Type.Union(resultInputSchema.anyOf, {
        description:
          "For query: file, directory, unchanged Read/Search/edit result, its UUID, or an array of such results.",
      }),
    ),
    references: Type.Optional(
      Type.Boolean({
        description:
          "For query: also follow symbols found inside path to their references outside it.",
      }),
    ),
    include: Type.Optional(Type.String({ description: "Include glob for query" })),
    exclude: Type.Optional(Type.String({ description: "Exclude glob for query" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum matches (default 100)." }),
    ),
  },
  { additionalProperties: false },
);

export type LspSearchParameters = Static<typeof lspSearchSchema>;

/** The shared Search core and the LSP resolver it runs for this tool only. */
export interface LspSearchRuntime {
  readonly api: SearchPluginApi;
  readonly resolver: SearchResolver;
}

/** Register the focused language-server tool on top of the shared Search execution core. */
export async function registerLspSearchTool(
  pi: ExtensionAPI,
  runtime: Promise<LspSearchRuntime>,
): Promise<void> {
  let resolved: LspSearchRuntime | undefined;
  void runtime.then((value) => (resolved = value));
  pi.registerTool(
    withToolCallInterceptionRendering(
      {
        name: "lsp_search",
        label: "lsp_search",
        exposure: "direct",
        namespace: { name: "ide_lsp_search", description: "Find code through language servers." },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          "Use lsp_search to find symbol declarations and references, read one declaration, or list a symbol's calls and references through the project's language servers. Matches and declarations are editable selections.",
        promptSnippet:
          "Find symbols, references, declarations and call graphs through language servers",
        parameters: lspSearchSchema,
        outputSchema: searchOutputSchema,
        renderCall(parameters, theme, context) {
          return toolCallHeader(
            context.lastComponent,
            {
              tool: "lsp_search",
              primary: {
                text: parameters.query ?? parameters.declaration ?? parameters.calls ?? "",
                color: "accent",
                truncate: "end",
              },
              qualifiers: [
                ...(parameters.declaration === undefined ? [] : [{ text: "declaration" }]),
                ...(parameters.calls === undefined ? [] : [{ text: "calls" }]),
                ...(parameters.path === undefined
                  ? []
                  : [
                      {
                        text:
                          typeof parameters.path === "string"
                            ? `in ${parameters.path}`
                            : "in result scope",
                        color: "accent" as const,
                        truncate: "start" as const,
                      },
                    ]),
                ...(parameters.references === true
                  ? [{ text: "references", color: "warning" as const }]
                  : []),
              ],
              expanded: context.expanded,
            },
            theme,
          );
        },
        renderResult(result, options, theme, context) {
          const details = result.details as SearchToolDetails | undefined;
          if (
            resolved?.resolver.renderResult !== undefined &&
            details?.payload !== undefined &&
            !context.isError &&
            !options.isPartial
          )
            return resolved.resolver.renderResult(
              { ...result, details: details.payload },
              options,
              theme,
              context,
            );
          const text = result.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
          return new ResultPanel(
            {
              summary: context.isError ? "lsp_search failed" : "lsp_search",
              rows: text.split("\n").map((line) => ({ kind: "note" as const, text: line })),
            },
            theme,
            options.expanded,
          );
        },
        async execute(
          _id,
          parameters: LspSearchParameters,
          signal,
          onUpdate,
          context,
        ): Promise<AgentToolResult<SearchToolDetails>> {
          const label = parameters.query ?? parameters.declaration ?? parameters.calls;
          const modes = [parameters.query, parameters.declaration, parameters.calls].filter(
            (value) => value !== undefined,
          );
          if (label === undefined || modes.length !== 1)
            return failure("Pass exactly one of query, declaration or calls.");
          const options: LspSearchOptions = {
            ...(parameters.query === undefined ? {} : { query: parameters.query }),
            ...(parameters.declaration === undefined
              ? {}
              : { declaration: parameters.declaration }),
            ...(parameters.calls === undefined ? {} : { calls: parameters.calls }),
            ...(parameters.references === true ? { references: true } : {}),
          };
          // The Search core registers this runtime during startup; without it the tool cannot run.
          if (resolved === undefined)
            return failure(
              "lsp_search needs the Search module (search.core), which is not loaded.",
            );
          const { api, resolver: lsp } = resolved;
          return (await api.searchWith(
            lsp,
            {
              // The resolver reads options; the query is the label kept with returned references.
              query: label,
              ...(parameters.path === undefined ? {} : { path: parameters.path }),
              ...(parameters.include === undefined ? {} : { include: parameters.include }),
              ...(parameters.exclude === undefined ? {} : { exclude: parameters.exclude }),
              ...(parameters.limit === undefined ? {} : { limit: parameters.limit }),
              options: { lsp: options },
            },
            {
              cwd: context.cwd,
              ...(signal !== undefined && { signal }),
              ...(onUpdate !== undefined && { onUpdate }),
            },
          )) as AgentToolResult<SearchToolDetails>;
        },
      },
      new ToolCallInterceptionRenderStore(),
    ),
  );
}

function failure(message: string): AgentToolResult<SearchToolDetails> {
  return withStructuredResult(
    {
      content: [{ type: "text", text: message }],
      details: { failure: { code: "INVALID_REQUEST", message } },
    },
    searchDataSchema,
    { status: "error", errors: [resultError(new Error(message), "SEARCH_FAILED")] },
  );
}
