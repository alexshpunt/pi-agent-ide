import { resolveCodeViewPath } from "pi-agent-ide/api/code-view";
import type { ResourceResolver, ResourceResolverContext } from "pi-agent-resource";

// A static import keeps the outline code from the version this Pi loaded.
import * as AstOutline from "./ast/outline.ts";
import { pageOutline, validateOutlineSnapshot, type OutlinePage } from "./outline-page.ts";

/** Acquire original text through its resource owner; never reinterpret a URI as a local path. */
export type AstOutlineSourceReader = (
  source: string,
  context: ResourceResolverContext,
) => Promise<{ source: string; lines: readonly string[] }>;

let defaultManager: AstOutline.AstOutlineManager | undefined;

export function createAstOutlineResolver(
  manager: AstOutline.AstOutlineManager | undefined,
  readSource: AstOutlineSourceReader,
  page: OutlinePage = {},
): ResourceResolver {
  return {
    id: "outline",
    async tryResolve(source, context) {
      let filePath: string;
      try {
        filePath = resolveCodeViewPath(source, context.cwd);
      } catch (error) {
        return { kind: "failed", error };
      }

      return {
        kind: "resolved",
        resource: {
          // Reserve the physical owner; the AST presentation remains read-only.
          source: filePath,
          link: filePath,
          async read({ signal }) {
            signal?.throwIfAborted();
            const snapshot = await readSource(filePath, { ...context, signal });
            signal?.throwIfAborted();
            validateOutlineSnapshot(snapshot.lines, source);
            const outlineManager =
              manager ?? (defaultManager ??= new AstOutline.AstOutlineManager());
            const outline = await outlineManager.readDocumentOutline(
              snapshot.source,
              context.cwd,
              snapshot.lines.length === 0 ? [""] : snapshot.lines,
            );
            signal?.throwIfAborted();
            if (outline.status === "failed")
              throw new Error(outline.error ?? "Could not produce an outline.");
            return [AstOutline.formatAstOutline(pageOutline(outline, source, page))];
          },
        },
      };
    },
  };
}
