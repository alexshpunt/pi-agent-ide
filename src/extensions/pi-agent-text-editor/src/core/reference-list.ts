import type { ResultSourceTarget, ResultTargetStore } from "pi-agent-resource";
import type { TextTarget } from "pi-agent-text";
import { TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";
import type { TextEditorCore } from "#src/core/text-editor-core.ts";

const RESULT_PREFIX = "RESULT#";
const NAME_LIMIT = 80;

function isSearchReference(value: string): boolean {
  return value.startsWith("SEARCH#");
}

function named(item: string): string {
  return item.length > NAME_LIMIT ? `${item.slice(0, NAME_LIMIT)}…` : item;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Search snapshots carry no reader of their own. The edit that consumes them re-reads each source
 * under its lock and compares it with `expectedContent`, so that comparison is the freshness check.
 */
function resultTarget(target: TextTarget): ResultSourceTarget {
  if (target.expectedContent === undefined || target.ranges === undefined)
    throw new Error("It does not select a text range.");
  const expected = target.expectedContent;
  return {
    source: target.source,
    expectedContent: expected,
    ranges: target.ranges,
    readCurrent: () => Promise.resolve(expected),
  };
}

/**
 * Turn a source array into registered `RESULT#` handles, one group per item and in the given order.
 * Items are references only: a Search reference, a `RESULT#` handle or an issued result. Every
 * edit tool with a list of targets follows one rule: every item that is expired, unknown, stale or
 * a plain path is collected, and one error names all of them with their reasons and current
 * lines. The call then changes nothing, so the agent repeats it once without the listed items.
 */
export async function expandReferenceList(
  core: Pick<TextEditorCore, "resolveTextAnchorResources">,
  store: ResultTargetStore,
  list: readonly unknown[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const handles: string[] = [];
  const failures: string[] = [];
  for (const item of list) {
    if (typeof item !== "string")
      throw new Error("A reference list holds strings only: Search references or issued results.");
    try {
      if (isSearchReference(item)) {
        const targets = await core.resolveTextAnchorResources(item, [TEXT_SEARCH_ANCHOR_KIND], {
          cwd,
          ...(signal !== undefined && { signal }),
        });
        if (targets === undefined)
          throw new Error("It was not issued by a Search in this session.");
        handles.push(store.register(targets.map(resultTarget), cwd));
        continue;
      }
      const resolved = store.source(item, cwd);
      const issued = Array.isArray(resolved) ? resolved : [resolved];
      for (const handle of issued) {
        if (typeof handle !== "string" || !handle.startsWith(RESULT_PREFIX))
          throw new Error(
            "It is a path. Arrays hold references only (SEARCH#…, RESULT#… or a result UUID); pass a path as a single string.",
          );
        store.resolve(handle, cwd);
        handles.push(handle);
      }
    } catch (error) {
      signal?.throwIfAborted();
      // A numbered Search reference arrives as the handle it names. A script passes that handle
      // itself as the id of a Search match, so the message names both.
      const name = store.referenceName(item);
      failures.push(
        `Reference ${named(name === item ? item : `${name} (${item})`)} cannot be used: ${describe(error).replaceAll("\n", "\n  ")}`,
      );
    }
  }
  if (failures.length > 0)
    throw new Error(
      [
        `${String(failures.length)} of ${String(list.length)} references cannot be used; nothing was changed. Repeat the call without them, or with fresh references for them:`,
        ...failures.map((failure) => `- ${failure}`),
      ].join("\n"),
    );
  return handles;
}
