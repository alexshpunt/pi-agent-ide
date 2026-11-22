import type { AstScopeManager } from "./ast/manager.ts";
import type { TextAnchorResolver } from "pi-agent-text";

/** `scope-begin-` or `scope-end-` and the line anchor of the scope's first line. */
const scopeAnchorPattern = /^scope-(begin|end)-[0-9A-HJKMNP-TV-Z]{7}$/;
/** Content hashes with an optional repeat suffix, issued before scopes were named by line anchors. */
const earlierScopeAnchorPattern = /^scope-(begin|end)-[A-Z0-9]{3,4}(?:-[1-9]\d*)?$/;

export function createAstScopeAnchorResolver(manager: AstScopeManager): TextAnchorResolver {
  return {
    id: "ast-scope",
    description:
      '`scope-begin-ANCHOR` / `scope-end-ANCHOR` from read views: ["ast"] — first/last lines of the scope whose first line has line anchor ANCHOR.',
    renderFull(value) {
      return value;
    },
    renderCompact(value) {
      const boundary = (scopeAnchorPattern.exec(value) ??
        earlierScopeAnchorPattern.exec(value))?.[1];
      return boundary === "begin" ? "scope start" : "scope end";
    },
    async tryResolve(value, context) {
      const stale = {
        kind: "rejected",
        rejection: { code: "stale", reason: `AST scope anchor ${value} is stale` },
      } as const;
      if (earlierScopeAnchorPattern.test(value)) {
        return stale;
      }
      if (!scopeAnchorPattern.test(value)) {
        return { kind: "not-handled" };
      }

      try {
        const scopes = await manager.getDocumentScopes(context.source, context.cwd, context.lines);
        const matches = scopes.filter(
          (candidate) =>
            candidate.beginAnchor.value === value || candidate.endScopeAnchor.value === value,
        );
        const [scope] = matches;

        if (scope === undefined) {
          return stale;
        }
        if (matches.length > 1) {
          return {
            kind: "rejected",
            rejection: {
              code: "ambiguous",
              reason: `AST scope anchor ${value} names ${String(matches.length)} scopes`,
            },
          };
        }

        return {
          kind: "resolved",
          anchor: scope.beginAnchor.value === value ? scope.beginAnchor : scope.endScopeAnchor,
        };
      } catch (error) {
        return { kind: "failed", error };
      }
    },
  };
}
