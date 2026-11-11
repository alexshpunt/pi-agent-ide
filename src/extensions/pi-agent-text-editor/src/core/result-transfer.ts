import type { ResolvedResultTargets, ResultTargetStore } from "pi-agent-resource";
import type {
  TextMutation,
  TextMutationContext,
  TextMutationEdit,
} from "#src/api/mutation-tool.ts";
import { TextChangeDocument, type TextChange } from "./text-change-engine.ts";
import { anchorSpanRange, insertionAfterAnchor } from "#src/tools/text-selection.ts";
import { wholeFileResultSource } from "./result-input.ts";
import { SOURCE_CHANGED } from "./source-change-retry.ts";

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
  /** One handle per selected range, in declared order, so every attempt can resolve them again. */
  const handles = new Map<"path" | "target", readonly string[]>();
  const resolve = (field: "path" | "target", start: string, end: string) => {
    if (!isResultInput(input[field])) return undefined;
    if (input[start] !== undefined || input[end] !== undefined)
      throw new Error(`Do not combine structured ${field} with ${start}/${end}.`);
    const selected = store.resolveOrdered(input[field], cwd);
    if (!selected.complete)
      throw new Error(
        "Incomplete result targets cannot establish a complete transfer. Run Search again with a higher limit or a narrower query, then use the complete result.",
      );
    input[field] = store.register(selected.targets, cwd);
    handles.set(
      field,
      selected.targets.map((target) => store.register([target], cwd)),
    );
    return selected;
  };
  const source = resolve("path", "start", "end");
  const destination = resolve("target", "targetStart", "targetEnd");
  if (source === undefined && destination === undefined) return { input, empty: false };
  if (
    source !== undefined &&
    destination === undefined &&
    input.targetStart === undefined &&
    input.targetEnd === undefined
  ) {
    // A structured source may use the byte-preserving file operation only when it really selects a whole file.
    // A file operation uses the selected file right away, so its text is checked here.
    await store.verify(source, signal);
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
      // Nothing is written, so the positions are checked against the file here.
      await store.verify(source, signal);
      await store.verify(destination, signal);
      assertMoveTargets(sources, destinations);
      return { input, empty: false, noOpTarget: store.register(destination.targets, cwd) };
    }
  }
  return {
    input,
    empty,
    async mutate(context) {
      // Each attempt takes the selections as the store has them now: moved to the file's current
      // text when another process wrote it, or refused with their current lines when their own
      // text changed.
      const current = (field: "path" | "target"): ResolvedResultTargets => ({
        targets: (handles.get(field) ?? []).flatMap((handle) => store.resolve(handle, cwd).targets),
        complete: true,
      });
      const spans = (selected: ResolvedResultTargets): TransferSpan[] =>
        selected.targets.map((target) => {
          const document = context.documentFor(target.source);
          if (document.content !== target.expectedContent)
            throw Object.assign(
              new Error("The selected text's file changed before the transfer; run it again."),
              { code: SOURCE_CHANGED },
            );
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
          : spans(current("path"));
      const destinations = destination === undefined ? undefined : spans(current("target"));
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
            change: { from: target.from, to: target.to, insert: copied },
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
      for (const transfer of planned) append(transfer.target, transfer.change, true);
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
