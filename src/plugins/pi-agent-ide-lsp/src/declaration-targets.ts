import { parseCodeViewReference, resolveCodeViewPath } from "pi-agent-ide/api/code-view";
import type { TextTargetResolver } from "pi-agent-text";
import { resolveLspDeclaration } from "./lsp/code-views.js";
import type { LspManagerProvider } from "./code-view-resolvers.js";

/** Resolve a live symbol reference to its exact declaration, not matching identifier words. */
export function createDeclarationTargets(managerFor: LspManagerProvider): TextTargetResolver {
  return {
    id: "lsp-declaration-target",
    async tryResolve(value, context) {
      const reference = parseCodeViewReference(value, "symbol");
      if (reference === undefined) return { kind: "not-handled" };
      if (reference.selector === undefined)
        return {
          kind: "rejected",
          rejection: {
            code: "invalid",
            reason: "Use symbol:<file>#<selector> to choose one declaration",
          },
        };
      try {
        const declaration = await resolveLspDeclaration(
          await managerFor(context.cwd),
          resolveCodeViewPath(reference.path, context.cwd),
          reference.selector,
          context.cwd,
          context.signal,
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
        return {
          kind: "failed",
          error: new Error(
            `${error instanceof Error ? error.message : String(error)} Read the physical file and use explicit text anchors if declaration resolution is unavailable.`,
            { cause: error },
          ),
        };
      }
    },
  };
}
