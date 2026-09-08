import { requiredValue } from "pi-agent-invariant";
import { createDiffModel, DIFF_CONTEXT_LINES, type DiffModel, type DiffRow } from "./diff-model.js";

import type { MutationRenderResource } from "./render-resource.js";
import type {
  TextMutationPreviewRange,
  TextMutationPreviewResource,
} from "pi-agent-text-editor/api/mutation-preview";

interface FrozenLineWindow {
  readonly beforeStart: number;
  readonly beforeEnd: number;

  readonly seedStart: number;
  readonly seedEnd: number;
}

interface FrozenResourceViewport {
  readonly path: string;
  readonly windows: readonly FrozenLineWindow[];
  readonly focusAfterLine?: number;
}

export interface FrozenMutationViewports {
  readonly resources: readonly FrozenResourceViewport[];
}

export function freezeMutationViewports(
  resources: readonly MutationRenderResource[],
): FrozenMutationViewports {
  return {
    resources: resources.flatMap((resource) => {
      const model =
        resource.model ??
        createDiffModel(resource.beforeContent, resource.afterContent, resource.ranges);
      const windows = freezeWindows(model, resource);
      const focusAfterLine = model.rows[model.focusRow]?.afterLine;
      return windows.length === 0
        ? []
        : [
            {
              path: resource.path,
              windows,
              ...(focusAfterLine !== undefined && { focusAfterLine }),
            },
          ];
    }),
  };
}

export function projectFinalResources(
  resources: readonly MutationRenderResource[],
  frozen: FrozenMutationViewports | undefined,
): readonly MutationRenderResource[] {
  return resources.map((resource) => {
    const viewport = frozen?.resources.find((candidate) => samePath(candidate.path, resource.path));

    if (viewport === undefined) {
      return {
        ...resource,
        model: createDiffModel(resource.beforeContent, resource.afterContent, resource.ranges),
      };
    }

    return {
      ...resource,
      model: createFrozenModel(
        resource.beforeContent,
        resource.afterContent,
        viewport,
        resource.diffPeerRanges,

        resource.finalLineOwnership,
      ),
    };
  });
}

function freezeWindows(
  model: DiffModel,
  resource: TextMutationPreviewResource,
): FrozenLineWindow[] {
  const windows: FrozenLineWindow[] = [];
  let group: DiffRow[] = [];

  const flush = (): void => {
    if (group.length === 0) {
      return;
    }

    const beforeLines = group.flatMap((row) =>
      row.beforeLine === undefined ? [] : [row.beforeLine],
    );
    const beforeAnchor = lineAtRange(resource.beforeContent, resource.beforeRanges?.at(-1));
    const beforeStart = beforeLines.length === 0 ? beforeAnchor - 1 : Math.min(...beforeLines) - 1;
    const beforeEnd = beforeLines.length === 0 ? beforeStart : Math.max(...beforeLines);
    const changedBefore = group.flatMap((row) =>
      row.changed && row.beforeLine !== undefined ? [row.beforeLine] : [],
    );
    const firstChanged = group.findIndex((row) => row.changed);
    const precedingLine = group
      .slice(0, firstChanged)
      .findLast((row) => row.beforeLine !== undefined)?.beforeLine;
    const followingLine = group
      .slice(firstChanged + 1)
      .find((row) => row.beforeLine !== undefined)?.beforeLine;
    const insertionAnchor =
      precedingLine ?? (followingLine === undefined ? beforeAnchor - 1 : followingLine - 1);
    windows.push({
      beforeStart,
      beforeEnd,

      seedStart: changedBefore.length === 0 ? insertionAnchor : Math.min(...changedBefore) - 1,
      seedEnd: changedBefore.length === 0 ? insertionAnchor : Math.max(...changedBefore),
    });
    group = [];
  };

  for (const row of model.rows) {
    if (row.kind === "omitted") {
      flush();
    } else {
      group.push(row);
    }
  }

  flush();
  return windows;
}

function createFrozenModel(
  beforeContent: string,
  afterContent: string,
  viewport: FrozenResourceViewport,

  peerRanges: MutationRenderResource["diffPeerRanges"] = [],

  finalLineOwnership?: MutationRenderResource["finalLineOwnership"],
): DiffModel {
  // Align the complete documents before selecting local rows. Slicing at old
  // after-line bounds would turn shifted context into fictitious changes.
  const full = createDiffModel(beforeContent, afterContent, [], { project: false });

  if (full.rows.length === 0 && beforeContent !== afterContent) {
    return { ...full, omittedChanges: { outside: 0, ambiguous: 0, unavailable: true } };
  }
  const selected = new Set<number>();
  let outside = 0;
  let ambiguous = 0;
  let beforeLine = 0;

  for (let index = 0; index < full.rows.length;) {
    const row = requiredValue(full.rows[index]);
    if (!row.changed) {
      beforeLine = row.beforeLine ?? beforeLine;
      index++;
      continue;
    }

    const start = index;
    const anchor = beforeLine;
    const originalLines: number[] = [];
    while (index < full.rows.length && requiredValue(full.rows[index]).changed) {
      const line = requiredValue(full.rows[index]).beforeLine;
      if (line !== undefined) {
        originalLines.push(line);
        beforeLine = line;
      }
      index++;
    }
    const first = originalLines.length === 0 ? anchor : Math.min(...originalLines) - 1;
    const last = originalLines.length === 0 ? anchor : Math.max(...originalLines);
    const touching = viewport.windows.filter((window) =>
      overlaps(first, last, window.seedStart, window.seedEnd),
    );
    const peerTouches = peerRanges.some((range) => {
      const start = lineAtRange(beforeContent, range) - 1;
      const end = lineAtRange(beforeContent, {
        from: Math.max(range.from, range.to - 1),
        to: range.to,
      });
      return overlaps(first, last, start, range.from === range.to ? start : end);
    });
    if (peerTouches) {
      if (touching.length > 0) {
        // A shared hunk has no reliable owner for newly inserted rows. Keep
        // original-line matches that belong only to this call, not its peers.
        for (let local = start; local < index; local++) {
          const line = requiredValue(full.rows[local]).beforeLine;

          const afterLine = requiredValue(full.rows[local]).afterLine;
          if (line === undefined && afterLine !== undefined && finalLineOwnership !== undefined) {
            const own = finalLineOwnership.own.includes(afterLine);
            const peer = finalLineOwnership.peers.includes(afterLine);
            if (own && !peer) selected.add(local);
            else if (own || !peer) ambiguous++;
            continue;
          }
          const own =
            line !== undefined &&
            touching.some((window) => overlaps(line - 1, line, window.seedStart, window.seedEnd));
          const peer =
            line !== undefined &&
            peerRanges.some((range) => {
              const first = lineAtRange(beforeContent, range) - 1;
              const last = lineAtRange(beforeContent, {
                from: Math.max(range.from, range.to - 1),
                to: range.to,
              });
              return overlaps(line - 1, line, first, last);
            });
          if (own && !peer) selected.add(local);
          else if (!peer || own) ambiguous++;
        }
      }
      continue;
    }
    if (touching.length === 0) {
      outside += index - start;
      continue;
    }
    if (!touching.some((window) => first >= window.beforeStart && last <= window.beforeEnd)) {
      ambiguous += index - start;
      continue;
    }
    for (let local = start; local < index; local++) selected.add(local);
  }

  for (const index of [...selected]) {
    for (
      let local = Math.max(0, index - DIFF_CONTEXT_LINES);
      local < Math.min(full.rows.length, index + DIFF_CONTEXT_LINES + 1);
      local++
    ) {
      if (!requiredValue(full.rows[local]).changed) selected.add(local);
    }
  }
  const rows: DiffRow[] = [];
  let previous = -1;
  for (const index of [...selected].sort((a, b) => a - b)) {
    if (previous !== -1 && index > previous + 1) {
      rows.push({ kind: "omitted", text: "", changed: false, omitted: index - previous - 1 });
    }
    rows.push(requiredValue(full.rows[index]));
    previous = index;
  }
  return {
    rows,
    added: rows.filter(({ kind }) => kind === "added").length,
    modified: rows.filter(({ kind }) => kind === "modified").length,
    removed: rows.filter(({ kind }) => kind === "removed").length,
    focusRow: focusRowAt(rows, viewport.focusAfterLine),
    ...(outside + ambiguous > 0 && { omittedChanges: { outside, ambiguous } }),
  };
}

function overlaps(first: number, last: number, start: number, end: number): boolean {
  if (first === last) return first >= start && first <= end;
  if (start === end) return start >= first && start <= last;
  return first < end && last > start;
}

function lineAtRange(content: string, range: TextMutationPreviewRange | undefined): number {
  const offset = range?.from ?? 0;
  return content.slice(0, offset).split("\n").length;
}

function focusRowAt(rows: readonly DiffRow[], line: number | undefined): number {
  if (line !== undefined) {
    const exact = rows.findLastIndex((row) => row.afterLine !== undefined && row.afterLine <= line);

    if (exact !== -1) {
      return exact;
    }
  }

  return Math.max(
    0,
    rows.findLastIndex(({ changed }) => changed),
  );
}

function samePath(left: string, right: string): boolean {
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}
