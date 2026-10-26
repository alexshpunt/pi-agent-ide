import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  searchOutputSchema,
  type SearchPluginApi,
  type SearchResolver,
  type SearchToolDetails,
} from "pi-agent-search/api/search";
import {
  ToolCallInterceptionRenderStore,
  withToolCallInterceptionRendering,
} from "pi-agent-tool-call-interception";
import { toolCallHeader } from "pi-agent-tool-ui";
import { Type, type Static } from "typebox";

import type { FileSearchOptions } from "#src/resolvers.js";

export const fileSearchSchema = Type.Object(
  {
    pattern: Type.String({
      minLength: 1,
      description:
        "Glob (*, **, ?, [abc], {a,b}) or plain text matched as a case-insensitive subsequence. A glob with / matches paths relative to path; one without / matches file names at any depth.",
    }),
    path: Type.Optional(
      Type.String({ description: "Directory to search, local or ssh://; defaults to cwd." }),
    ),
    include: Type.Optional(Type.String({ description: "Include glob" })),
    exclude: Type.Optional(Type.String({ description: "Exclude glob" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum files (default 100)." }),
    ),
  },
  { additionalProperties: false },
);

export type FileSearchParameters = Static<typeof fileSearchSchema>;

/** Register the file-path search tool; it runs `resolver` through the shared Search core only. */
export function registerFileSearchTool(
  pi: ExtensionAPI,
  resolver: SearchResolver,
  search: Promise<SearchPluginApi>,
): void {
  pi.registerTool(
    withToolCallInterceptionRendering(
      {
        name: "file_search",
        label: "file_search",
        exposure: "direct",
        namespace: { name: "ide_file_search", description: "Find files by path." },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          "Use file_search to find file paths by glob or partial name, locally or over SSH. Pass a returned path to read or an edit tool.",
        promptSnippet: "Find file paths by glob or partial name",
        parameters: fileSearchSchema,
        outputSchema: searchOutputSchema,
        renderCall(parameters, theme, context) {
          return toolCallHeader(
            context.lastComponent,
            {
              tool: "file_search",
              primary: { text: parameters.pattern, color: "accent", truncate: "end" },
              qualifiers: [
                ...(parameters.path === undefined
                  ? []
                  : [
                      {
                        text: `in ${parameters.path}`,
                        color: "accent" as const,
                        truncate: "start" as const,
                      },
                    ]),
                ...(parameters.include === undefined
                  ? []
                  : [{ text: `include ${parameters.include}` }]),
                ...(parameters.exclude === undefined
                  ? []
                  : [{ text: `exclude ${parameters.exclude}` }]),
                ...(parameters.limit === undefined
                  ? []
                  : [{ text: `limit ${String(parameters.limit)}` }]),
              ],
              expanded: context.expanded,
            },
            theme,
          );
        },
        renderResult(result, options, theme, context) {
          const details = result.details as SearchToolDetails | undefined;
          if (
            resolver.renderResult !== undefined &&
            details?.payload !== undefined &&
            !context.isError &&
            !options.isPartial
          )
            return resolver.renderResult(
              { ...result, details: details.payload },
              options,
              theme,
              context,
            );
          return new Text(
            result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
            0,
            0,
          );
        },
        async execute(
          _id,
          parameters: FileSearchParameters,
          signal,
          onUpdate,
          context,
        ): Promise<AgentToolResult<SearchToolDetails>> {
          const options: FileSearchOptions = { pattern: parameters.pattern };
          return (await (
            await search
          ).searchWith(
            resolver,
            {
              // The resolver reads options; the query is the label kept with the result.
              query: parameters.pattern,
              ...(parameters.path === undefined ? {} : { path: parameters.path }),
              ...(parameters.include === undefined ? {} : { include: parameters.include }),
              ...(parameters.exclude === undefined ? {} : { exclude: parameters.exclude }),
              ...(parameters.limit === undefined ? {} : { limit: parameters.limit }),
              options: { files: options },
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
