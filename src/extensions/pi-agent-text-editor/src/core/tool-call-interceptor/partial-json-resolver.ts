import { Allow, parse } from "partial-json";

/**
 * Attempt to parse a (possibly partial) JSON string.
 * Returns the best-effort parsed value, or `undefined` if nothing
 * could be extracted (empty, malformed, or still streaming).
 *
 * Works with any JSON schema — not tied to any tool structure.
 *
 * @example
 * ```ts
 * const data = resolvePartial('{"edits":[{"path":"a.ts","start":"begin"');
 * // → { edits: [{ path: "a.ts", start: "begin" }] }
 * ```
 */
export function resolvePartial(json: string, allowPartial = Allow.ALL): Record<string, unknown> | undefined
{
    if (!json || json.trim().length === 0)
    {
        return undefined;
    }

    try
    {
        const result = parse(json, allowPartial) as Record<string, unknown> | null | undefined;

        if (result === null || result === undefined)
        {
            return undefined;
        }

        if (typeof result !== "object" || Array.isArray(result))
        {
            return undefined;
        }

        return result;
    }
    catch
    {
        return undefined;
    }
}
