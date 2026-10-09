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

import { selectStructuralRegions } from "./ast/selection.js";
import { publicRange } from "./selection-region.js";
import { selectTextRegions } from "./text-selection.js";
import { selectGeometryRegions } from "./geometry-selection.js";
import {
  selectSchema,
  selectOutputSchema,
  selectionDataSchema,
  type SelectionData,
  type SelectParameters,
  type GeometrySelectOperation,
} from "./select-schema.js";
/** Show selected text and opaque item references, never the internal selection record. */
function selectionText(data: SelectionData): string {
  const rows = [`${data.totalItems} selection(s)${data.complete ? "" : " · incomplete input"}`];
  if (!data.complete)
    rows.push("Obtain complete source selections before checking absence or editing.");
  if (data.missingInputs) rows.push(`${data.missingInputs} input range(s) produced no selection`);
  for (const item of data.items) {
    const range = item.range;
    rows.push(
      `${item.target} ${item.source}:${range.startLine}:${range.startColumn}–${range.endLine}:${range.endColumn}${item.syntax ? ` ${item.syntax.object}${item.syntax.part ? `/${item.syntax.part}` : ""}` : ""}`,
      item.preview,
    );
    if (range.startLine === range.endLine && range.startColumn === range.endColumn)
      rows.push("Zero-width position; no text selected.");
    if (item.textTruncated)
      rows.push("… preview shortened; pass this item reference to consume the full selection");
  }
  if (data.truncated)
    rows.push("… more selections retained; pass the whole result to consume all selections");
  return rows.join("\n");
}

function operationLabel(operation: SelectParameters["operation"]): string {
  switch (operation.kind) {
    case "object": {
      return `enclosing ${operation.object} · level ${operation.level ?? 1}`;
    }
    case "part": {
      return `part ${operation.part}`;
    }
    case "elementExtent": {
      return `list element · ${operation.extent}`;
    }
    case "navigate": {
      return `${operation.relation}${operation.relation === "siblings" ? ` ${operation.direction ?? "all"}` : ""}${operation.object ? ` · ${operation.object}` : ""}`;
    }
    case "between": {
      return `between ${JSON.stringify(operation.start)} … ${JSON.stringify(operation.end)} · ${operation.extent}`;
    }
    case "range": {
      return `range ${operation.startLine}:${operation.startColumn}–${operation.endLine}:${operation.endColumn}`;
    }
    case "lines": {
      return `lines ${operation.first}–${operation.last}`;
    }
    case "sliceText": {
      return `text slice ${operation.from}–${operation.to ?? "end"}`;
    }
    case "trim": {
      return `trim ${operation.side}`;
    }
    case "split": {
      return `split ${JSON.stringify(operation.delimiter)}`;
    }
    case "linesOf": {
      return "containing lines";
    }
    case "position": {
      return `position ${operation.edge}`;
    }
    case "columns": {
      return `columns ${operation.from}–${operation.to}`;
    }
    case "within":
    case "intersection":
    case "difference": {
      return operation.kind;
    }
    case "merge": {
      return operation.adjacent ? "merge overlaps and adjacent ranges" : "merge overlaps";
    }
  }
}
function isGeometryOperation(
  operation: SelectParameters["operation"],
): operation is GeometrySelectOperation {
  return (
    operation.kind === "within" ||
    operation.kind === "intersection" ||
    operation.kind === "difference" ||
    operation.kind === "merge"
  );
}
/** Register read-only text and AST selection using the existing Read and source-target backends. */
export async function registerSelect(pi: ExtensionAPI, read: ReadPluginApi): Promise<void> {
  const targets = connectResultTargets(pi);
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "select-code",
      description:
        "Derive text and AST boundaries, navigate constructs and combine source-range sets",
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
          "Use select to derive text ranges or positions, navigate JavaScript/TypeScript constructs and their parts (without JSX/TSX), and combine source-local selections. Pass the returned result or an item reference to Read, Search or an edit tool. Select does not change files.",
        promptSnippet:
          "Derive text and AST boundaries, navigate constructs and combine source-range sets",
        promptGuidelines: [
          "Use Search for predicate matches and existing captures; use Select when a target needs new text or structural boundaries.",
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
                text: operationLabel(parameters.operation),
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
          if (typeof presentation?.summary === "string" && Array.isArray(presentation.rows))
            return new ResultPanel(presentation, theme, options.expanded);
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
            const resolve = async (source: unknown) => {
              if (typeof source === "string" && !source.startsWith("RESULT#")) {
                const resolved = await read.read(
                  { path: source },
                  { cwd: context.cwd, ...(signal !== undefined && { signal }) },
                  "script",
                );
                if (resolved.isError) throw new Error("Select could not read this source.");
                source = resolved.script;
              }
              return targets.resolve(source, context.cwd);
            };
            const input = await resolve(parameters.path);
            const operation = parameters.operation;
            const scopes =
              isGeometryOperation(operation) && "scopes" in operation
                ? await resolve(operation.scopes)
                : { targets: [], complete: true };
            const verified = {
              targets: [...input.targets, ...scopes.targets],
              complete: input.complete && scopes.complete,
            };
            await targets.verify(verified, signal);
            const selected = isGeometryOperation(operation)
              ? selectGeometryRegions(input, operation, scopes, signal)
              : operation.kind === "object" ||
                  operation.kind === "part" ||
                  operation.kind === "navigate" ||
                  operation.kind === "elementExtent"
                ? await selectStructuralRegions(input, operation, context.cwd, signal)
                : selectTextRegions(input, operation, signal);
            await targets.verify(verified, signal);
            signal?.throwIfAborted();
            const sourceTargets = selected.regions.map((region) => ({
              ...region.target,
              ranges: [region.range],
            }));
            const data: SelectionData = {
              kind: "selection",
              target: targets.register(sourceTargets, context.cwd, verified.complete),
              complete: verified.complete,
              totalItems: selected.regions.length,
              missingInputs: selected.missingInputs,
              truncated: selected.regions.length > 100,
              items: selected.regions.slice(0, 100).map((region) => {
                const preview = region.text.slice(0, 1000).replace(/[\uD800-\uDBFF]$/u, "");
                return {
                  target: targets.register(
                    [{ ...region.target, ranges: [region.range] }],
                    context.cwd,
                    verified.complete,
                  ),
                  source: region.target.source,
                  range: publicRange(region.range),
                  origins: region.origins,
                  ...(region.syntax ? { syntax: region.syntax } : {}),
                  preview,
                  textTruncated: preview.length < region.text.length,
                };
              }),
            };
            return withStructuredResult(
              {
                content: [{ type: "text", text: selectionText(data) }],
                details: selectPresentation(
                  selected.regions,
                  verified.complete,
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
                  {
                    type: "text",
                    text: `${error instanceof Error ? error.message : String(error)}\nResolve the reported error before retrying. Do not treat a failed selection as an empty result.`,
                  },
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
