import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";
import { resultError, resultInputSchema, withStructuredResult } from "pi-agent-resource";
import {
  searchDataSchema,
  searchOutputSchema,
  type SearchPluginApi,
  type SearchResolver,
  type SearchToolDetails,
} from "pi-agent-search/api/search";
import { renderSearchResult } from "pi-agent-search-text/rendering";
import {
  ToolCallInterceptionRenderStore,
  withToolCallInterceptionRendering,
} from "pi-agent-tool-call-interception";
import { toolCallHeader } from "pi-agent-tool-ui";
import { Type, type Static } from "typebox";

import type { AstSearchOptions } from "./search-resolver.js";

export const astSearchSchema = Type.Object(
  {
    pattern: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "ast-grep pattern in source-code syntax; $NAME captures one node, $$$ARGS several. Use pattern or rule.",
      }),
    ),
    rule: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "ast-grep rule object, the value of `rule:` in an ast-grep rule file: pattern, kind, regex, inside, has, not, all, any, follows, precedes, stopBy. Requires language.",
      }),
    ),
    language: Type.Optional(
      Type.String({
        minLength: 1,
        description: "ast-grep language for a rule, such as typescript, python or go.",
      }),
    ),
    path: Type.Optional({
      ...resultInputSchema,
      description:
        "File, directory, unchanged Read/Search/edit result, its UUID, or an array of such results.",
    }),
    relation: Type.Optional(
      Type.Union([Type.Literal("inside"), Type.Literal("enclosing")], {
        description:
          "With a result as path: inside (default) keeps matches within its ranges; enclosing returns the innermost match that contains each range.",
      }),
    ),
    include: Type.Optional(Type.String({ description: "Include glob for files" })),
    exclude: Type.Optional(Type.String({ description: "Exclude glob for files" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum matches (default 100)." }),
    ),
  },
  { additionalProperties: false },
);

export type AstSearchParameters = Static<typeof astSearchSchema>;

/** The shared Search core and the AST resolver it runs for this tool only. */
export interface AstSearchRuntime {
  readonly api: SearchPluginApi;
  readonly resolver: SearchResolver;
}

/** Register the focused syntax-search tool on top of the shared Search execution core. */
export async function registerAstSearchTool(
  pi: ExtensionAPI,
  runtime: () => Promise<AstSearchRuntime>,
): Promise<void> {
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "ast-search",
      description: "Syntax patterns, ast-grep rules and enclosing constructs",
      triggers: [{ tool: "ast_search" }],
    }),
  ]);
  pi.registerTool(
    withToolCallInterceptionRendering(
      {
        name: "ast_search",
        label: "ast_search",
        exposure: "direct",
        namespace: { name: "ide_ast_search", description: "Find code by syntax structure." },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          "Use ast_search to find code by syntax with ast-grep patterns or rules, in files or inside a Read, Search or edit result, and to get the function, class or call that encloses a match. Matches and captures are editable selections.",
        promptSnippet: "Find code by syntax with ast-grep patterns and relational rules",
        promptGuidelines: [
          "Use ast_search when a match depends on code structure, such as a call inside a given function or the function that contains a text match.",
        ],
        parameters: astSearchSchema,
        outputSchema: searchOutputSchema,
        renderCall(parameters, theme, context) {
          return toolCallHeader(
            context.lastComponent,
            {
              tool: "ast_search",
              primary: {
                text:
                  parameters.pattern ??
                  (parameters.rule === undefined ? "" : JSON.stringify(parameters.rule)),
                color: "accent",
                truncate: "end",
              },
              qualifiers: [
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
                ...(parameters.language === undefined ? [] : [{ text: parameters.language }]),
                ...(parameters.relation === "enclosing" ? [{ text: "enclosing" }] : []),
              ],
              expanded: context.expanded,
            },
            theme,
          );
        },
        renderResult(result, options, theme, context) {
          const details = result.details as SearchToolDetails | undefined;
          if (details?.payload !== undefined && !context.isError && !options.isPartial)
            return renderSearchResult(
              { ...result, details: details.payload } as never,
              options,
              theme,
              context as never,
            );
          return new Text(
            result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
            0,
            0,
          );
        },
        async execute(
          _id,
          parameters: AstSearchParameters,
          signal,
          onUpdate,
          context,
        ): Promise<AgentToolResult<SearchToolDetails>> {
          if ((parameters.pattern === undefined) === (parameters.rule === undefined))
            return failure("Pass exactly one of pattern or rule.");
          if (parameters.rule !== undefined && parameters.language === undefined)
            return failure("A rule requires language, such as typescript or python.");
          const options: AstSearchOptions = {
            ...(parameters.pattern === undefined ? {} : { pattern: parameters.pattern }),
            ...(parameters.rule === undefined ? {} : { rule: parameters.rule }),
            ...(parameters.language === undefined ? {} : { language: parameters.language }),
            ...(parameters.relation === undefined ? {} : { relation: parameters.relation }),
          };
          const { api, resolver } = await runtime();
          return (await api.searchWith(
            resolver,
            {
              // The resolver reads options; the query is the label kept with returned references.
              query: parameters.pattern ?? JSON.stringify(parameters.rule),
              ...(parameters.path === undefined ? {} : { path: parameters.path }),
              ...(parameters.include === undefined ? {} : { include: parameters.include }),
              ...(parameters.exclude === undefined ? {} : { exclude: parameters.exclude }),
              ...(parameters.limit === undefined ? {} : { limit: parameters.limit }),
              options: { ast: options },
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
