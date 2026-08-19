import { TextAnchorResolutionError } from "#src/core/text-anchor-registry.js";

export class TextMutationAnchorResolutionError extends Error
{
    public constructor(
        readonly toolName: string,
        readonly field: string,
        readonly source: string,
        readonly anchor: string,
        readonly resolution: TextAnchorResolutionError,
    )
    {
        super(resolution.message, { cause: resolution });
    }
}

export function contextualizeTextMutationAnchorError(
    error: unknown,
    toolName: string,
    field: string,
    source: string,
    anchor: string,
): unknown
{
    return error instanceof TextAnchorResolutionError
        ? new TextMutationAnchorResolutionError(toolName, field, source, anchor, error)
        : error;
}
