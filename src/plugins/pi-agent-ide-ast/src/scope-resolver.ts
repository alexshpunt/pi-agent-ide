import type { AstScopeManager } from "./ast/manager.js";
import type { TextAnchorResolver } from "pi-agent-text";

const scopeAnchorPattern = /^scope-(begin|end)-[A-Z0-9]{3,4}(?:-[1-9]\d*)?$/;

export function createAstScopeAnchorResolver(manager: AstScopeManager): TextAnchorResolver
{
    return {
        id: "ast-scope",
        description:
            "Use `scope-begin-HASH` or `scope-end-HASH` as shown beside source lines; a numeric suffix may distinguish repeated scopes.",
        async tryResolve(value, context)
        {
            if (!scopeAnchorPattern.test(value))
            {
                return { kind: "not-handled" };
            }

            try
            {
                const scopes = await manager.getDocumentScopes(context.source, context.cwd, context.lines);
                const scope = scopes.find((candidate) =>
                    candidate.beginAnchor.value === value || candidate.endScopeAnchor.value === value
                );

                if (scope === undefined)
                {
                    return {
                        kind: "rejected",
                        rejection: { code: "stale", reason: `AST scope anchor ${value} is stale` },
                    };
                }

                return {
                    kind: "resolved",
                    anchor: scope.beginAnchor.value === value ? scope.beginAnchor : scope.endScopeAnchor,
                };
            }
            catch (error)
            {
                return { kind: "failed", error };
            }
        },
    };
}
