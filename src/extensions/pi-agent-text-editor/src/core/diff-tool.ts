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
import {
  readParameters,
  type ReadScriptData,
  type ReadToolResult,
} from "pi-agent-read/api/tools/read";
import type { ReadPluginApi } from "pi-agent-read/api/plugin-protocol";
import type { TextEditorCore } from "#src/core/text-editor-core.js";
import { createUnifiedDiff, type DiffStats } from "#src/core/mutation-result/diff.js";
import { FileMutationResult } from "#src/core/mutation-result/file-mutation-result.js";

const source = Type.Union([Type.String({ minLength: 1 }), readParameters]);
/** Each side accepts a source string or the same request object as read. */
export const diffParameters = Type.Object(
  { before: source, after: source },
  { additionalProperties: false },
);
export type DiffRequest = Static<typeof diffParameters>;
interface ComparisonText {
  readonly source: string;
  readonly sources: readonly string[];
  readonly content: string;
}
/** Full comparison data for Apply; this is not an edit receipt. */
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
    throw Object.assign(new Error(`Byte sources are not text: ${data.source}`), {
      code: "UNSUPPORTED_CONTENT",
    });
  if (data.blocks.length === 0 || data.blocks.some((block) => block.type !== "text"))
    throw Object.assign(new Error(`Source is not text: ${data.source}`), {
      code: "UNSUPPORTED_CONTENT",
    });
  return {
    source: data.source,
    sources: [data.source],
    content: data.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
  };
}

/** Recognize comparison results without confusing them with mutations. */
export function isDiffOutcome(value: unknown): value is DiffOutcome {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "diff" &&
    "ok" in value &&
    value.ok === true
  );
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
/** Presentation remains separate from complete comparison data. */
export function diffReadResult(value: DiffOutcome): ReadToolResult {
  return { content: [{ type: "text", text: diffText(value) }], details: {} };
}

/** Standalone diff uses the same read service and configured editor renderer as Apply. */
export function registerDiff(
  pi: ExtensionAPI,
  editor: TextEditorCore,
  getRead: () => ReadPluginApi | undefined,
): void {
  pi.registerTool({
    name: "diff",
    label: "Diff",
    parameters: diffParameters,
    promptSnippet: "Compare two text-readable sources without changing them",
    description:
      "Use diff to compare two sources without modifying them. before and after accept a source string or a read request {path, offset?, limit?, views?}. Use any source that read can resolve as text. Omit limit to compare complete resolved text; read presentation limits do not clip comparison inputs. Multiple resolved resources are joined with one newline separator in resolver order. Diff line numbers are relative to each selected text, not the original file when a window is selected. Native non-text content is rejected. Output uses the existing text diff and a shared output budget; oversized output has a full temporary reference. The same diff function is available inside Apply.",
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
      const comparison = await executeDiff(read, args, { cwd: context.cwd, signal });
      const full = diffText(comparison);
      const bounded = truncateHead(full);
      const temporarySource = bounded.truncated ? await read.saveTemporary(full) : undefined;
      const footer = temporarySource === undefined ? "" : `\nFull diff: ${temporarySource}`;
      return {
        content: [
          {
            type: "text" as const,
            text:
              temporarySource === undefined
                ? full
                : truncateHead(full, {
                    maxLines: DEFAULT_MAX_LINES - 2,
                    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(footer),
                  }).content + footer,
          },
        ],
        details: { ...diffPresentation(comparison, context.cwd), comparison, temporarySource },
      };
    },
  });
}
