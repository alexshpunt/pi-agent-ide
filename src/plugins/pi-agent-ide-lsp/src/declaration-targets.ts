import { parseCodeViewReference, resolveCodeViewPath } from "pi-agent-ide/api/code-view";
import type { TextTargetResolver } from "pi-agent-text";
import { resolveLspDeclaration } from "./lsp/code-views.ts";
import { withLspDocuments } from "./lsp/document-leases.ts";
import type { LspManagerProvider } from "./manager-provider.ts";

/** Resolve a live symbol reference to its exact declaration, not matching identifier words. */
export function createDeclarationTargets(managerFor: LspManagerProvider): TextTargetResolver {
  return {
    id: "lsp-declaration-target",
    async tryResolve(value, context) {
      const reference = parseCodeViewReference(value, "symbol");
      // #name belongs to the rename pre-edit handler, not declaration-text fallback.
      if (reference === undefined || value.endsWith("#name")) return { kind: "not-handled" };
      if (reference.selector === undefined)
        return {
          kind: "rejected",
          rejection: {
            code: "invalid",
            reason: "Use symbol:<file>#<selector> to choose one declaration",
          },
        };
      try {
        const selector = reference.selector;
        const declaration = await withLspDocuments(async () =>
          resolveLspDeclaration(
            await managerFor(
              context.cwd,
              resolveCodeViewPath(reference.path, context.cwd),
              context.signal,
            ),
            resolveCodeViewPath(reference.path, context.cwd),
            selector,
            context.cwd,
            context.signal,
          ),
        );
        return {
          kind: "resolved",
          targets: [
            {
              source: declaration.source,
              expectedContent: declaration.content,
              ranges: [
                {
                  start: {
                    lineNumber: declaration.range.start.line + 1,
                    column: declaration.range.start.character,
                  },
                  end: {
                    lineNumber: declaration.range.end.line + 1,
                    column: declaration.range.end.character,
                  },
                },
              ],
            },
          ],
        };
      } catch (error) {
        if (context.signal?.aborted) return { kind: "failed", error };
        // Edit tools hide the text of resolver failures; a rejection shows the agent why the
        // declaration is unavailable, such as a language server that could not start.
        return {
          kind: "rejected",
          rejection: {
            code: "invalid",
            reason: `${error instanceof Error ? error.message : String(error)} Read the physical file and use explicit text anchors if declaration resolution is unavailable.`,
          },
        };
      }
    },
  };
}
