import type { ResolvedResultTargets, ResultTargetStore } from "pi-agent-resource";
import type {
  TextMutation,
  TextMutationContext,
  TextMutationEdit,
} from "#src/api/mutation-tool.js";
import { TextChangeDocument, type TextChange } from "./text-change-engine.js";
import {
  anchorSpanRange,
  insertionAfterAnchor,
  replaceAnchorSpan,
} from "#src/tools/text-selection.js";
import { wholeFileResultSource } from "./result-input.js";

/** Distinguish structured source authority from ordinary paths and legacy anchors. */
export function isResultInput(value: unknown): boolean {
  return value !== undefined && (typeof value !== "string" || value.startsWith("RESULT#"));
}

interface TransferSpan {
  readonly source: string;
  readonly from: number;
  readonly to: number;
}

interface PreparedTransfer {
  readonly input: Readonly<Record<string, unknown>>;
  readonly empty: boolean;
  /** Verified unchanged destination points; no editor operation is needed. */
  readonly noOpTarget?: string;
  readonly verifyFileSource?: () => Promise<void>;
  readonly mutate?: (context: TextMutationContext) => Promise<TextMutation>;
}

/** Resolve ordered pairs once; execute them inside the editor's existing guarded snapshots. */
export async function prepareResultTransfer(
  operation: "copy" | "move",
  parameters: Readonly<Record<string, unknown>>,
  store: ResultTargetStore,
  cwd: string,
  signal?: AbortSignal,
): Promise<PreparedTransfer> {
  const input = { ...parameters };
  const resolve = async (field: "path" | "target", start: string, end: string) => {
    if (!isResultInput(input[field])) return undefined;
    if (input[start] !== undefined || input[end] !== undefined)
      throw new Error(`Do not combine structured ${field} with ${start}/${end}.`);
    const selected = store.resolveOrdered(input[field], cwd);
    if (!selected.complete)
      throw new Error(
        "Incomplete result targets cannot establish a complete transfer. Run Search again with a higher limit or a narrower query, then use the complete result.",
      );
    await store.verify(selected, signal);
    input[field] = store.register(selected.targets, cwd);
    return selected;
  };
  const source = await resolve("path", "start", "end");
  const destination = await resolve("target", "targetStart", "targetEnd");
  if (source === undefined && destination === undefined) return { input, empty: false };
  if (
    source !== undefined &&
    destination === undefined &&
    input.targetStart === undefined &&
    input.targetEnd === undefined
  ) {
    // A structured source may use the byte-preserving file operation only when it really selects a whole file.
    input.path = wholeFileResultSource(store.resolve(parameters.path, cwd));
    return { input, empty: false, verifyFileSource: () => store.verify(source, signal) };
  }
  if (
    source !== undefined &&
    destination !== undefined &&
    source.targets.length !== destination.targets.length
  )
    throw new Error(
      "Transfer source and destination selection counts must match; no broadcast or concatenation.",
    );
  const empty = source?.targets.length === 0 || destination?.targets.length === 0;
  if (operation === "move" && !empty && source !== undefined && destination !== undefined) {
    const spans = (selected: ResolvedResultTargets): TransferSpan[] =>
      selected.targets.map((target) => {
        const range = target.ranges[0];
        if (range === undefined) throw new Error("Transfer selection has no range.");
        return {
          source: target.source,
          ...new TextChangeDocument(target.expectedContent).range(
            range.start.lineNumber,
            range.start.column,
            range.end.lineNumber,
            range.end.column,
          ),
        };
      });
    const sources = spans(source);
    const destinations = spans(destination);
    if ([...sources, ...destinations].every((span) => span.from === span.to)) {
      assertMoveTargets(sources, destinations);
      return { input, empty: false, noOpTarget: store.register(destination.targets, cwd) };
    }
  }
  return {
    input,
    empty,
    async mutate(context) {
      const spans = (selected: ResolvedResultTargets): TransferSpan[] =>
        selected.targets.map((target) => {
          const document = context.documentFor(target.source);
          if (document.content !== target.expectedContent)
            throw new Error("Transfer result target is stale; repeat Read/Search.");
          const range = target.ranges[0];
          if (range === undefined) throw new Error("Transfer selection has no range.");
          return {
            source: target.source,
            ...document.range(
              range.start.lineNumber,
              range.start.column,
              range.end.lineNumber,
              range.end.column,
            ),
          };
        });
      const sources =
        source === undefined
          ? [
              input.start === undefined
                ? { source: context.sourceFor("path"), from: 0, to: context.sourceDocument.length }
                : anchorSpanRange(
                    context,
                    await context.resolveAnchors("start"),
                    input.end === undefined ? undefined : await context.resolveAnchors("end"),
                    "start",
                    "end",
                  ),
            ]
          : spans(source);
      const destinations = destination === undefined ? undefined : spans(destination);
      if (sources.length !== (destinations?.length ?? 1))
        throw new Error(
          "Transfer source and destination selection counts must match; no broadcast or concatenation.",
        );
      const edits = new Map<string, TextMutationEdit>();
      const append = (span: TransferSpan, change: TextChange, producesTarget: boolean) => {
        const edit = edits.get(span.source);
        const changes = [...(edit?.changes ?? []), change];
        const resultChanges = [
          ...(edit?.resultChanges ?? []),
          ...(producesTarget ? [changes.length - 1] : []),
        ];
        edits.set(span.source, { action: "edited", changes, resultChanges });
      };
      const planned: { target: TransferSpan; change: TextChange }[] = [];
      for (const [index, span] of sources.entries()) {
        const copied = context.documentFor(span.source).text(span);
        const destinationSpan = destinations?.[index];
        if (destinationSpan !== undefined) {
          planned.push({
            target: destinationSpan,
            change: { from: destinationSpan.from, to: destinationSpan.to, insert: copied },
          });
          continue;
        }
        const starts = await context.resolveAnchors("targetStart");
        if (input.targetEnd === undefined) {
          const [target, change] = insertionAfterAnchor(context, starts, "targetStart", copied);
          planned.push({
            target: { source: target, from: change.from, to: change.to },
            change,
          });
        } else {
          const target = anchorSpanRange(
            context,
            starts,
            await context.resolveAnchors("targetEnd"),
            "targetStart",
            "targetEnd",
          );
          planned.push({
            target,
            change: replaceAnchorSpan(context, target, copied),
          });
        }
      }
      if (operation === "move") {
        assertMoveTargets(
          sources,
          planned.map((transfer) => transfer.target),
        );
        for (const span of sources)
          append(span, { from: span.from, to: span.to, insert: "" }, false);
      }
      for (const transfer of planned)
        append(
          transfer.target,
          operation === "copy" ? { ...transfer.change, allowUnchanged: true } : transfer.change,
          true,
        );
      return { edits };
    },
  };
}

function assertMoveTargets(
  sources: readonly TransferSpan[],
  destinations: readonly TransferSpan[],
): void {
  for (const source of sources)
    for (const target of destinations)
      if (source.source === target.source && source.from <= target.to && target.from <= source.to)
        throw new Error("Move target must not overlap or touch any source range.");
}
