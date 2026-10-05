import type { ResolvedResultTargets, ResultRange, ResultSourceTarget } from "pi-agent-resource";
import {
  publicRange,
  retainRegion,
  SelectionError,
  type SelectedRegion,
} from "./selection-region.js";
import { SourceText } from "./source-text.js";
import type { GeometrySelectOperation } from "./select-schema.js";

interface Seed {
  readonly target: ResultSourceTarget;
  readonly range: ResultRange;
  readonly from: number;
  readonly to: number;
}
interface Span {
  readonly from: number;
  readonly to: number;
  readonly seeds: readonly Seed[];
}

/** Combine verified ranges as source-local sets, retaining candidate associations and real gaps. */
export function selectGeometryRegions(
  input: ResolvedResultTargets,
  operation: Pick<GeometrySelectOperation, "kind"> & { readonly adjacent?: boolean },
  scopes: ResolvedResultTargets,
  signal?: AbortSignal,
): { readonly regions: readonly SelectedRegion[]; readonly missingInputs: number } {
  signal?.throwIfAborted();
  const sources = new Map<string, SourceText>();
  for (const target of [...input.targets, ...scopes.targets]) {
    signal?.throwIfAborted();
    const previous = sources.get(target.source);
    if (previous && previous.content !== target.expectedContent)
      throw new SelectionError(
        "INCOMPATIBLE_SNAPSHOTS",
        "Geometry inputs use different snapshots of the same source.",
      );
    if (!previous) sources.set(target.source, new SourceText(target.expectedContent));
  }
  const candidates = seedsBySource(input, sources, signal);
  const masks = seedsBySource(scopes, sources, signal);
  const selected = new Map<string, SelectedRegion>();
  let missingInputs = 0;
  for (const [file, seeds] of candidates) {
    signal?.throwIfAborted();
    const source = sources.get(file);
    if (!source) throw new SelectionError("MISSING_SOURCE", "Verified source text is unavailable.");
    const scopeSeeds = masks.get(file) ?? [];
    const union = mergeSpans(scopeSeeds.map(asSpan), true, signal);
    const output: Span[] = [];
    if (operation.kind === "merge")
      output.push(...mergeSpans(seeds.map(asSpan), operation.adjacent ?? false, signal));
    else
      for (const seed of seeds) {
        signal?.throwIfAborted();
        const pieces = transform(seed, scopeSeeds, union, operation.kind, signal);
        if (!pieces.length) missingInputs++;
        output.push(...pieces);
      }
    for (const span of output) {
      signal?.throwIfAborted();
      const first = span.seeds[0];
      if (!first)
        throw new SelectionError("MISSING_ORIGIN", "Geometry output has no candidate origin.");
      retainRegion(selected, {
        target: first.target,
        range: source.range(span.from, span.to),
        text: source.content.slice(span.from, span.to),
        origins: span.seeds.map((seed) => ({
          source: file,
          range: publicRange(seed.range),
          expanded: span.from < seed.from || span.to > seed.to,
        })),
      });
    }
  }
  return { regions: [...selected.values()], missingInputs };
}

function seedsBySource(
  input: ResolvedResultTargets,
  sources: ReadonlyMap<string, SourceText>,
  signal?: AbortSignal,
): Map<string, Seed[]> {
  const groups = new Map<string, Seed[]>();
  for (const target of input.targets) {
    const source = sources.get(target.source);
    if (!source) throw new SelectionError("MISSING_SOURCE", "Verified source text is unavailable.");
    const seeds = groups.get(target.source) ?? [];
    for (const range of target.ranges) {
      signal?.throwIfAborted();
      const from = source.offset(range.start);
      const to = source.offset(range.end);
      source.range(from, to);
      seeds.push({ target, range, from, to });
    }
    groups.set(target.source, seeds);
  }
  return groups;
}

function asSpan(seed: Seed): Span {
  return { from: seed.from, to: seed.to, seeds: [seed] };
}

function contains(scope: Pick<Span, "from" | "to">, candidate: Pick<Span, "from" | "to">): boolean {
  if (candidate.from === candidate.to)
    return scope.from === scope.to
      ? candidate.from === scope.from
      : scope.from <= candidate.from && candidate.from < scope.to;
  return scope.from <= candidate.from && candidate.to <= scope.to;
}

function transform(
  seed: Seed,
  scopes: readonly Seed[],
  union: readonly Span[],
  kind: "within" | "intersection" | "difference",
  signal?: AbortSignal,
): Span[] {
  if (kind === "within") return scopes.some((scope) => contains(scope, seed)) ? [asSpan(seed)] : [];
  if (seed.from === seed.to) {
    const covered = union.some((scope) => contains(scope, seed));
    return covered === (kind === "intersection") ? [asSpan(seed)] : [];
  }
  if (kind === "intersection") {
    const intersections: Span[] = [];
    for (const scope of union) {
      signal?.throwIfAborted();
      if (scope.from === scope.to) {
        if (contains(seed, scope))
          intersections.push({ from: scope.from, to: scope.to, seeds: [seed] });
      } else {
        const from = Math.max(seed.from, scope.from);
        const to = Math.min(seed.to, scope.to);
        if (from < to) intersections.push({ from, to, seeds: [seed] });
      }
    }
    return intersections;
  }
  const fragments: Span[] = [];
  let from = seed.from;
  for (const scope of union) {
    signal?.throwIfAborted();
    if (scope.from === scope.to || scope.to <= from || scope.from >= seed.to) continue;
    if (scope.from > from) fragments.push({ from, to: scope.from, seeds: [seed] });
    from = Math.max(from, scope.to);
    if (from >= seed.to) break;
  }
  if (from < seed.to) fragments.push({ from, to: seed.to, seeds: [seed] });
  return fragments;
}

function mergeSpans(spans: readonly Span[], adjacent: boolean, signal?: AbortSignal): Span[] {
  const ordered = [...spans].sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: Span[] = [];
  for (const span of ordered) {
    signal?.throwIfAborted();
    if (span.from === span.to) continue;
    const previous = merged.at(-1);
    if (previous && (span.from < previous.to || (adjacent && span.from === previous.to)))
      merged[merged.length - 1] = {
        from: previous.from,
        to: Math.max(previous.to, span.to),
        seeds: [...previous.seeds, ...span.seeds],
      };
    else merged.push(span);
  }
  const points = new Map<number, Span>();
  for (const span of ordered) {
    signal?.throwIfAborted();
    if (span.from !== span.to) continue;
    const owner = merged.findIndex((range) => contains(range, span));
    const previous = owner >= 0 ? merged[owner] : points.get(span.from);
    const combined = previous ? { ...previous, seeds: [...previous.seeds, ...span.seeds] } : span;
    if (owner >= 0) merged[owner] = combined;
    else points.set(span.from, combined);
  }
  return [...merged, ...points.values()].sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
}
