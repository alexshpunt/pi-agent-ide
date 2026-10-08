import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { readParameters, type ReadScriptData } from "pi-agent-read/api/tools/read";
import type { ReadPluginApi } from "pi-agent-read/api/plugin-protocol";
import type { TextEditorCore } from "#src/core/text-editor-core.js";
import { createUnifiedDiff, type DiffStats } from "#src/core/mutation-result/diff.js";
import { FileMutationResult } from "#src/core/mutation-result/file-mutation-result.js";
import { resultError, structuredResultSchema, withStructuredResult } from "pi-agent-resource";
const comparisonSourceSchema = Type.Object(
  { source: Type.String(), sources: Type.Array(Type.String()) },
  { additionalProperties: false },
);
export const diffDataSchema = Type.Object(
  {
    kind: Type.Literal("diff"),
    equal: Type.Boolean(),
    before: comparisonSourceSchema,
    after: comparisonSourceSchema,
    stats: Type.Object({ added: Type.Integer(), removed: Type.Integer() }),
    diff: Type.String(),
    truncated: Type.Boolean(),
    fullResult: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export const diffOutputSchema = structuredResultSchema(diffDataSchema);

const comparisonReadParameters = {
  ...readParameters,
  properties: {
    ...readParameters.properties,
    path: {
      ...readParameters.properties.path,
      description:
        "Text-readable source accepted by Read, such as a file path, URL, temp: reference, SEARCH# or RESULT# reference, or registered resource. Supply a path.",
    },
    offset: {
      ...readParameters.properties.offset,
      description:
        "First text line to compare, numbered from 1. Omit or use 0 to start at line 1; negative offsets count from the end. For path#anchor, SEARCH# or RESULT# selections, count from the containing line: omitted, 0 or 1 starts there, 2 starts one line later, -1 one line earlier.",
    },
    limit: {
      ...readParameters.properties.limit,
      description:
        "Maximum text lines to compare from the selected starting position. Omit to compare all resolved text in the selected range. Read's display limits do not shorten the comparison inputs.",
    },
  },
};
const source = Type.Union([Type.String({ minLength: 1 }), comparisonReadParameters]);
/** Each side accepts a source string or the same request object as read. */
export const diffParameters = Type.Object(
  {
    before: {
      ...source,
      description:
        "Source for the removed (-) side. Supply a non-empty source reference string or a Read request object. Strings identify sources, not literal text.",
    },
    after: {
      ...source,
      description:
        "Source for the added (+) side. Supply a non-empty source reference string or a Read request object. Strings identify sources, not literal text.",
    },
  },
  { additionalProperties: false },
);
export type DiffRequest = Static<typeof diffParameters>;
interface ComparisonText {
  readonly source: string;
  readonly sources: readonly string[];
  readonly content: string;
}
/** Full comparison data; this is not an edit receipt. */
export interface DiffOutcome {
  readonly kind: "diff";
  readonly ok: true;
  readonly equal: boolean;
  readonly before: ComparisonText;
  readonly after: ComparisonText;
  readonly diff: string;
  readonly stats: DiffStats;
}

/** Read both sides through the configured read pipeline without presentation clipping. */
export async function executeDiff(
  read: ReadPluginApi,
  input: unknown,
  context: { cwd: string; signal?: AbortSignal },
): Promise<DiffOutcome> {
  if (!Value.Check(diffParameters, input))
    throw Object.assign(new Error("Use before and after source strings or read request objects"), {
      code: "INVALID_ARGUMENTS",
    });
  const request = input;
  const resolve = async (side: DiffRequest["before"]) => {
    const request = typeof side === "string" ? { path: side } : side;
    const outcome = await read.read(request, context, "script");
    if (outcome.isError || outcome.details.failure)
      throw Object.assign(new Error(outcome.details.failure?.message ?? "Comparison read failed"), {
        code: outcome.details.failure?.code ?? "READ_FAILED",
        details: outcome.details.failure,
      });
    if (outcome.script === undefined)
      throw Object.assign(new Error("Source has no comparable text data"), {
        code: "UNSUPPORTED_CONTENT",
      });
    return comparisonText(outcome.script, request.path ?? "source");
  };
  const before = await resolve(request.before);
  const after = await resolve(request.after);
  const result = createUnifiedDiff(before.source, before.content, after.content, after.source);
  return {
    kind: "diff",
    ok: true,
    equal: before.content === after.content,
    before,
    after,
    ...result,
  };
}

/** Preserve canonical text, joining multiple resolved resources with one newline separator. */
export function comparisonText(data: ReadScriptData, requested: string): ComparisonText {
  if (data.kind === "text")
    return { source: data.source, sources: [data.source], content: data.content };
  if (data.kind === "resources") {
    const texts = data.resources.map((resource) => comparisonText(resource, requested));
    return {
      source: data.source ?? requested,
      sources: texts.flatMap((text) => text.sources),
      content: texts.map((text) => text.content).join("\n"),
    };
  }
  if (data.kind === "bytes")
    throw Object.assign(
      new Error(
        `Byte sources are not text: ${data.source}\nIf this is a text file, use its path without raw:.`,
      ),
      {
        code: "UNSUPPORTED_CONTENT",
      },
    );
  if (data.blocks.length === 0 || data.blocks.some((block) => block.type !== "text"))
    throw Object.assign(
      new Error(`Source is not text: ${data.source}\nUse a source that Read resolves to text.`),
      {
        code: "UNSUPPORTED_CONTENT",
      },
    );
  return {
    source: data.source,
    sources: [data.source],
    content: data.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
  };
}

/** Reuse the editor panel's existing before/after presentation contract, without executing edits. */
export function diffPresentation(value: DiffOutcome, cwd = process.cwd()) {
  const displaySource = (source: string) =>
    path.isAbsolute(source) ? path.relative(cwd, source) || "." : source;
  const label = `Diff: ${displaySource(value.before.source)} → ${displaySource(value.after.source)}`;
  return {
    results: [
      new FileMutationResult({
        ok: true,
        path: label,
        beforeContentMap: { [label]: value.before.content },
        afterContent: value.after.content,
        diffs: [value.diff],
      }),
    ],
  };
}
/** The agent sees the existing unified text diff with both source names. */
export function diffText(value: DiffOutcome): string {
  return value.equal
    ? `No differences: ${value.before.source} → ${value.after.source}`
    : value.diff;
}

/** Compare sources through the shared read service and configured editor renderer. */
export function registerDiff(
  pi: ExtensionAPI,
  editor: TextEditorCore,
  getRead: () => ReadPluginApi | undefined,
): void {
  pi.registerTool({
    name: "diff",
    exposure: "direct",
    namespace: { name: "ide_read", description: "Read resources and compare sources." },
    // Inputs use the same polymorphic resource pipeline as Read.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    label: "Diff",
    parameters: diffParameters,
    outputSchema: diffOutputSchema,
    promptSnippet: "Compare two text-readable sources",
    description: "Use diff to compare two text-readable sources without changing them.",
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Diff")), 0, 0);
    },
    renderResult(result, options, theme, context) {
      const details = result.details as { comparison?: DiffOutcome } | undefined;
      if (details?.comparison?.equal) return new Text(diffText(details.comparison), 0, 0);
      const renderer = editor.getToolRenderer("diff")
        ?.renderResult as ToolDefinition["renderResult"];
      return renderer
        ? renderer(result, options, theme, context)
        : new Text(
            result.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
            0,
            0,
          );
    },
    async execute(_id, args, signal, _update, context) {
      const read = getRead();
      if (read === undefined) throw new Error("Diff requires the read extension");
      try {
        const comparison = await executeDiff(read, args, { cwd: context.cwd, signal });
        const full = diffText(comparison);
        const bounded = truncateHead(full);
        const temporarySource = bounded.truncated ? await read.saveTemporary(full) : undefined;
        const footer =
          temporarySource === undefined
            ? ""
            : `\nDiff output is truncated; the comparison used the complete resolved inputs.\nUse read with path "${temporarySource}" for the full diff.`;
        return withStructuredResult(
          {
            content: [
              {
                type: "text" as const,
                text:
                  temporarySource === undefined
                    ? full
                    : truncateHead(full, {
                        maxLines: DEFAULT_MAX_LINES - footer.split("\n").length,
                        maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(footer),
                      }).content + footer,
              },
            ],
            details: { ...diffPresentation(comparison, context.cwd), comparison, temporarySource },
          },
          diffDataSchema,
          {
            status: "success",
            data: {
              kind: "diff",
              equal: comparison.equal,
              before: { source: comparison.before.source, sources: comparison.before.sources },
              after: { source: comparison.after.source, sources: comparison.after.sources },
              stats: comparison.stats,
              diff: bounded.content,
              truncated: bounded.truncated,
              ...(temporarySource === undefined ? {} : { fullResult: temporarySource }),
            },
            errors: [],
          },
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        const failure = resultError(error, "DIFF_FAILED");
        return withStructuredResult(
          { content: [{ type: "text", text: failure.message }], details: {} },
          diffDataSchema,
          { status: "error", errors: [failure] },
        );
      }
    },
  });
}
