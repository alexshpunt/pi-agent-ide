import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";
import type { ReadPluginApi } from "pi-agent-read/api/plugin-protocol";
import { connectResultTargets, resultError, withStructuredResult } from "pi-agent-resource";
import { ResultPanel, toolCallHeader, type ResultPanelModel } from "pi-agent-tool-ui";
import {
  ToolCallInterceptionRenderStore,
  withToolCallInterceptionRendering,
} from "pi-agent-tool-call-interception";
import { selectPresentation } from "./select-presentation.js";
import { publicRange, selectFunctionRegions } from "./ast/selection.js";
import {
  selectSchema,
  selectOutputSchema,
  selectionDataSchema,
  type SelectionData,
  type SelectParameters,
} from "./select-schema.js";

/** Register read-only AST boundary selection using the existing Read and source-target backends. */
export async function registerSelect(pi: ExtensionAPI, read: ReadPluginApi): Promise<void> {
  const targets = connectResultTargets(pi);
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "select-code",
      description: "Derive containing functions and their bodies from verified source targets",
      triggers: [{ tool: "select" }],
    }),
  ]);
  pi.registerTool(
    withToolCallInterceptionRendering(
      {
        name: "select",
        label: "select",
        exposure: "direct",
        namespace: {
          name: "ide_select",
          description: "Derive exact source boundaries from existing targets.",
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          "Use select to derive the nearest enclosing JavaScript/TypeScript function or the body of an exact function target, without JSX/TSX. object/function/enclosing/level=1/around contains the entire seed and can expand beyond it. part/body requires an exact function target and includes braces, or the expression of an arrow; nested functions remain included. Results retain strict snapshots, input associations and individually consumable items; preview truncation does not clip the whole target. No ownBody, arbitrary ranges or other operations are implemented.",
        promptSnippet: "Derive exact enclosing functions and bodies from verified source targets",
        promptGuidelines: [
          "Use Search for predicate matches and existing captures; use Select only when new structural boundaries are needed.",
          "Compare the enclosing owner of each inner match with the original function when checking a condition in that function's own body.",
        ],
        parameters: selectSchema,
        outputSchema: selectOutputSchema,
        renderCall(parameters, theme, context) {
          return toolCallHeader(
            context.lastComponent,
            {
              tool: "select",
              primary: {
                text:
                  parameters.operation.kind === "object" ? "enclosing function" : "function body",
                color: "accent",
              },
              qualifiers: [
                {
                  text:
                    typeof parameters.path === "string" && !parameters.path.startsWith("RESULT#")
                      ? parameters.path
                      : "in result scope",
                },
              ],
              expanded: context.expanded,
            },
            theme,
          );
        },
        renderResult(result, options, theme) {
          const presentation = result.details as ResultPanelModel | undefined;
          if (presentation) return new ResultPanel(presentation, theme, options.expanded);
          return new Text(
            result.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n"),
            0,
            0,
          );
        },
        async execute(_id, parameters: SelectParameters, signal, _onUpdate, context) {
          try {
            signal?.throwIfAborted();
            let source: unknown = parameters.path;
            if (typeof parameters.path === "string" && !parameters.path.startsWith("RESULT#")) {
              const resolved = await read.read(
                { path: parameters.path },
                {
                  cwd: context.cwd,
                  ...(signal !== undefined && { signal }),
                },
                "script",
              );
              if (resolved.isError) throw new Error("Select could not read this source.");
              source = resolved.script;
            }
            const input = targets.resolve(source, context.cwd);
            await targets.verify(input, signal);
            const selected = await selectFunctionRegions(
              input,
              parameters.operation,
              context.cwd,
              signal,
            );
            await targets.verify(input, signal);
            signal?.throwIfAborted();
            const sourceTargets = selected.regions.map((region) => ({
              ...region.target,
              ranges: [region.range],
            }));
            const data: SelectionData = {
              kind: "selection",
              target: targets.register(sourceTargets, context.cwd, input.complete),
              complete: input.complete,
              totalItems: selected.regions.length,
              missingInputs: selected.missingInputs,
              truncated: selected.regions.length > 100,
              items: selected.regions.slice(0, 100).map((region) => {
                const preview = region.text.slice(0, 1000).replace(/[\uD800-\uDBFF]$/u, "");
                return {
                  target: targets.register(
                    [{ ...region.target, ranges: [region.range] }],
                    context.cwd,
                    input.complete,
                  ),
                  source: region.target.source,
                  range: publicRange(region.range),
                  origins: region.origins,
                  preview,
                  textTruncated: preview.length < region.text.length,
                };
              }),
            };
            return withStructuredResult(
              {
                content: [{ type: "text", text: JSON.stringify(data) }],
                details: selectPresentation(
                  selected.regions,
                  input.complete,
                  selected.missingInputs,
                  context.cwd,
                ),
              },
              selectionDataSchema,
              { status: "success", data, errors: [] },
            );
          } catch (error) {
            if (signal?.aborted) throw error;
            return withStructuredResult<ResultPanelModel | undefined, never>(
              {
                content: [
                  { type: "text", text: error instanceof Error ? error.message : String(error) },
                ],
                details: undefined,
              },
              selectionDataSchema,
              { status: "error", errors: [resultError(error, "SELECT_FAILED")] },
            );
          }
        },
      },
      new ToolCallInterceptionRenderStore(),
    ),
  );
}
