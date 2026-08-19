import { formatCodeViewReference, parseCodeViewReference, resolveCodeViewPath } from "pi-agent-ide/api/code-view";

import type * as AstOutline from "./ast/outline.js";
import type { ResourceResolutionAttempt, ResourceResolver, ResourceResolverContext } from "pi-agent-resource";

let defaultManager: AstOutline.AstOutlineManager | undefined;
let astOutlineModule: Promise<typeof AstOutline> | undefined;

export function createAstOutlineResolver(manager?: AstOutline.AstOutlineManager): ResourceResolver
{
    return {
        id: "ast",
        tryResolve(source, context)
        {
            return Promise.resolve(resolveAstOutlineSource(source, context, manager));
        },
    };
}

function resolveAstOutlineSource(
    source: string,
    context: ResourceResolverContext,
    manager: AstOutline.AstOutlineManager | undefined,
): ResourceResolutionAttempt
{
    let reference;

    try
    {
        reference = parseCodeViewReference(source, "ast");
    }
    catch (error)
    {
        return { kind: "failed", error };
    }

    if (reference === undefined)
    {
        return { kind: "not-handled" };
    }

    let filePath: string;

    try
    {
        filePath = resolveCodeViewPath(reference.path, context.cwd);
    }
    catch (error)
    {
        return { kind: "failed", error };
    }

    const canonicalSource = formatCodeViewReference("ast", filePath);
    return {
        kind: "resolved",
        resource: {
            source: canonicalSource,
            async read({ signal })
            {
                signal?.throwIfAborted();
                const astOutline = await (astOutlineModule ??= import("./ast/outline.js"));
                const outlineManager = manager ?? (defaultManager ??= new astOutline.AstOutlineManager());
                const outline = await outlineManager.readFileOutline(filePath, context.cwd);
                signal?.throwIfAborted();
                return [astOutline.formatAstOutline(outline)];
            },
        },
    };
}
