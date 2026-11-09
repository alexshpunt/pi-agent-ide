import type {
  ResolvedResultTargets,
  ResultSourceTarget,
  ResultTargetStore,
} from "pi-agent-resource";
import type { TextTarget } from "pi-agent-text";
import { TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";
import type { TextEditorCore } from "#src/core/text-editor-core.ts";

/** A Search reference is resolved by its owning session, not by the result store. */
export function isSearchReference(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("SEARCH#");
}

/** True when a source list holds at least one Search reference. */
export function hasSearchReference(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.some(isSearchReference);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultTarget(target: TextTarget): ResultSourceTarget {
  if (target.expectedContent === undefined || target.ranges === undefined)
    throw new Error("It does not select a text range.");
  return {
    source: target.source,
    expectedContent: target.expectedContent,
    ranges: target.ranges,
  };
}

/**
 * Resolve a source list that mixes Search references with issued results. Every Search reference
 * resolves through the same owner as a single `path` reference; the first one that is expired,
 * unknown or stale rejects the whole list, and the error names it. Issued results are verified
 * here; Search selections are checked against the current text when the edit reads it.
 */
export async function resolveSearchReferenceList(
  core: Pick<TextEditorCore, "resolveTextAnchorResources">,
  store: ResultTargetStore,
  list: readonly unknown[],
  cwd: string,
  signal?: AbortSignal,
): Promise<ResolvedResultTargets> {
  const items: unknown[] = [];
  const issued: unknown[] = [];
  for (const item of list) {
    if (!isSearchReference(item)) {
      items.push(item);
      issued.push(item);
      continue;
    }
    let targets: readonly TextTarget[] | undefined;
    try {
      targets = await core.resolveTextAnchorResources(item, [TEXT_SEARCH_ANCHOR_KIND], {
        cwd,
        ...(signal !== undefined && { signal }),
      });
      if (targets === undefined) throw new Error("It was not issued by a Search in this session.");
      items.push(store.register(targets.map(resultTarget), cwd));
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Search reference ${item} cannot be used: ${describe(error)}`, {
        cause: error,
      });
    }
  }
  if (issued.length > 0) await store.verify(store.resolve(issued, cwd), signal);
  return store.resolve(items, cwd);
}
