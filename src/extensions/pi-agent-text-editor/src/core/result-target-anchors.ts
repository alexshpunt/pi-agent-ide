import type { ResultTargetStore } from "pi-agent-resource";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";
import {
  TEXT_SEARCH_ANCHOR_KIND,
  type TextAnchorResolverRegistration,
} from "#src/api/plugin-protocol.js";

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
          if (target.expectedContent !== context.content)
            return {
              kind: "rejected",
              rejection: { code: "stale", reason: "Result target is stale; repeat Read/Search." },
            };
          return {
            kind: "resolved",
            anchor: new TextSelectionAnchor(value, target.source, target.ranges),
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
          await store.verify(selected, context.signal);
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
