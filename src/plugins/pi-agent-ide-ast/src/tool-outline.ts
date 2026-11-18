import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadResultRenderer } from "pi-agent-read/api/rendering";
import {
  readOutputSchema,
  structuredRead,
  type ReadScriptData,
  type ReadToolPluginApi,
  type ReadToolResult,
} from "pi-agent-read/api/tools/read";
import { connectResultTargets, trackScriptCalls, type ResultRange } from "pi-agent-resource";
import { getTextSourceLine } from "pi-agent-text";
import { OUTLINE_PAGE_ROWS } from "./outline-page.ts";
import { createAstOutlineResolver } from "./outline-resolver.ts";
import {
  ToolCallInterceptionRenderStore,
  withToolCallInterceptionRendering,
} from "pi-agent-tool-call-interception";
import { toolCallHeader } from "pi-agent-tool-ui";
import { Type } from "typebox";

export interface OutlineRuntime {
  readonly api: ReadToolPluginApi;
}

/** Share Read's source-mapped pipeline without adding another Read source scheme. */
export function registerOutlineTool(
  pi: ExtensionAPI,
  runtime: () => OutlineRuntime | undefined,
): void {
  const scriptCall = trackScriptCalls(pi, "outline");
  const targets = connectResultTargets(pi);
  const renderResult = createReadResultRenderer({ kind: "code-view", label: "Outline" });
  pi.registerTool(
    withToolCallInterceptionRendering(
      {
        name: "outline",
        label: "outline",
        exposure: "direct",
        namespace: { name: "ide_outline", description: "Inspect code declarations." },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        description:
          "Use outline to inspect one page of a file's declarations without reading their implementations. Reuse the page in read, search, ast_search or edit tools to select its original source lines.",
        promptSnippet: "Inspect a local or SSH file's declaration outline",
        parameters: Type.Object(
          {
            path: Type.String({
              minLength: 1,
              description: "Local file path or ssh://<target>/absolute/path.",
            }),
            offset: Type.Optional(
              Type.Integer({
                minimum: 1,
                description:
                  "First projected outline row (1-based; default 1), not a source line number.",
              }),
            ),
            limit: Type.Optional(
              Type.Integer({
                minimum: 1,
                maximum: OUTLINE_PAGE_ROWS,
                description: "Maximum outline rows to return (default 100).",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        outputSchema: readOutputSchema,
        renderCall(parameters, theme, context) {
          return toolCallHeader(
            context.lastComponent,
            {
              tool: "outline",
              primary: { text: parameters.path, color: "accent", truncate: "start" },
              expanded: context.expanded,
            },
            theme,
          );
        },
        renderResult,
        async execute(id, parameters, signal, _onUpdate, context) {
          const current = runtime();
          let result: ReadToolResult;
          try {
            if (current === undefined)
              throw new Error("outline needs the Read module (read.core), which is not loaded.");
            let snapshot: Extract<ReadScriptData, { kind: "text" }> | undefined;
            const resolver = createAstOutlineResolver(
              undefined,
              async (source, resolverContext) => {
                const owned = await current.api.read({ path: source }, resolverContext, "script");
                if (
                  owned.isError ||
                  owned.script?.kind !== "text" ||
                  owned.script.entries !== undefined
                )
                  throw new Error(
                    owned.details.failure?.message ?? "Outline requires an owned text file.",
                  );
                snapshot = owned.script;
                return {
                  source: snapshot.source,
                  lines: snapshot.lines.map((line) => line.content),
                };
              },
              parameters,
            );
            result = await current.api.readWith(
              resolver,
              { path: parameters.path, views: ["anchors"] },
              {
                cwd: context.cwd,
                ...(signal === undefined ? {} : { signal }),
              },
              scriptCall(id) ? "script" : "agent",
            );
            if (!result.isError && result.script?.kind === "text" && snapshot !== undefined) {
              const source = snapshot.source;
              const ranges: ResultRange[] = result.script.lines.flatMap((line) => {
                const original = getTextSourceLine(line);
                if (original?.source !== source) return [];
                const saved = snapshot?.lines[original.lineNumber - 1];
                if (saved === undefined || saved.content !== original.content) return [];
                return [
                  {
                    start: { lineNumber: original.lineNumber, column: 0 },
                    end:
                      saved.lineEnding.length > 0
                        ? { lineNumber: original.lineNumber + 1, column: 0 }
                        : { lineNumber: original.lineNumber, column: saved.content.length },
                    linewise: true,
                  },
                ];
              });
              const target = targets.register(
                [
                  {
                    source,
                    expectedContent: snapshot.content,
                    ranges,
                    readCurrent: ownedReader(current.api, source, context.cwd),
                  },
                ],
                context.cwd,
              );
              result = { ...result, script: { ...result.script, target } };
            }
          } catch (error) {
            if (signal?.aborted) throw error;
            result = {
              content: [
                { type: "text", text: error instanceof Error ? error.message : String(error) },
              ],
              details: {
                failure: {
                  code: "READ_FAILED",
                  source: parameters.path,
                  message: error instanceof Error ? error.message : String(error),
                },
              },
              isError: true,
            };
          }
          const { script: _script, ...output } = structuredRead(result, {
            complete: scriptCall(id),
          });
          return output;
        },
      },
      new ToolCallInterceptionRenderStore(),
    ),
  );
}

/** Keep only the owner and its reread, not the original outline pipeline state. */
function ownedReader(api: ReadToolPluginApi, source: string, cwd: string) {
  return async (signal?: AbortSignal): Promise<string> => {
    const result = await api.read(
      { path: source },
      { cwd, ...(signal === undefined ? {} : { signal }) },
      "script",
    );
    if (result.isError || result.script?.kind !== "text" || result.script.source !== source)
      throw new Error("Could not verify the outline's owning source; repeat outline.");
    return result.script.content;
  };
}
