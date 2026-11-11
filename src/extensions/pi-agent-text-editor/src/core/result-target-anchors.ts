import { rangesInText, type ResultTargetStore } from "pi-agent-resource";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.ts";
import {
  TEXT_SEARCH_ANCHOR_KIND,
  type TextAnchorResolverRegistration,
} from "#src/api/plugin-protocol.ts";

/** Resolve registered snapshot targets through the editor's normal source and anchor guards. */
export function createResultTargetAnchors(
  store: ResultTargetStore,
): TextAnchorResolverRegistration {
  return {
    kind: TEXT_SEARCH_ANCHOR_KIND,
    type: "auxiliary",
    describeInPrompt: false,
    resolver: {
      id: "result-targets",
      description: "Use returned RESULT# references to target exact source snapshots.",
      renderFull: (value) => value,
      renderCompact: () => "result targets",
      async tryResolve(value, context) {
        if (!value.startsWith("RESULT#")) return { kind: "not-handled" };
        try {
          const target = store
            .resolve(value, context.cwd)
            .targets.find((target) => target.source === context.source);
          if (target === undefined)
            return {
              kind: "rejected",
              rejection: { code: "missing", reason: "Result does not select this source." },
            };
          // Resolve in the caller's text: the store may already hold this selection on a newer
          // text, or the caller may have read the file before another session wrote it.
          const ranges = rangesInText(target.ranges, target.expectedContent, context.content);
          if (ranges === undefined)
            return {
              kind: "rejected",
              rejection: { code: "stale", reason: "Result target is stale; repeat Read/Search." },
            };
          return {
            kind: "resolved",
            anchor: new TextSelectionAnchor(value, target.source, ranges),
          };
        } catch (error) {
          return {
            kind: "rejected",
            rejection: {
              code: "invalid",
              reason: error instanceof Error ? error.message : String(error),
            },
          };
        }
      },
    },
    resources: {
      id: "result-target-sources",
      async tryResolve(value, context) {
        if (!value.startsWith("RESULT#")) return { kind: "not-handled" };
        try {
          const selected = store.resolve(value, context.cwd);
          // An edit compares each target with its file under the file lock and runs again on newer
          // text, so a write by another session after this point must not fail it here. Other
          // consumers, such as Read, use the selected lines now and need them to match the file.
          if (context.edit === undefined) await store.verify(selected, context.signal);
          else await store.verifyUnfollowed(selected, context.signal);
          return selected.targets.length === 0
            ? {
                kind: "rejected",
                rejection: { code: "missing", reason: "Empty result target set." },
              }
            : { kind: "resolved", targets: selected.targets };
        } catch (error) {
          context.signal?.throwIfAborted();
          return {
            kind: "rejected",
            rejection: {
              code: "stale",
              reason: error instanceof Error ? error.message : String(error),
            },
          };
        }
      },
    },
  };
}
