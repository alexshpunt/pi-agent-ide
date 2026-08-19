import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createTextDocument, type TextAnchorResolutionAttempt, type TextAnchorResolver } from "pi-agent-text";
import { TextSelectionAnchor } from "pi-agent-text-editor/api/text-selection-anchor";

import type {
    TextAnchorResourceResolutionAttempt,
    TextAnchorResourceResolver,
} from "pi-agent-text-editor/api/plugin-protocol";

const searchAnchorPattern = /^SEARCH#([A-F0-9]{8}):(all|[1-9]\d*)$/u;

export interface TextSearchMatch
{
    readonly source: string;
    readonly lineNumber: number;
    readonly startColumn: number;
    readonly endColumn: number;
    readonly matchedText: string;
    readonly lineText: string;
}

export interface TextSearchSession
{
    readonly id: string;
    readonly query: string;
    readonly matches: readonly TextSearchMatch[];
    readonly complete: boolean;
}

interface StoredSearchSession extends TextSearchSession
{
    readonly contentBySource: ReadonlyMap<string, string>;
}

interface ParsedSearchAnchor
{
    readonly id: string;
    readonly selector: "all" | number;
}

export function createSearchSessionId(
    query: string,
    matches: readonly TextSearchMatch[],
    cwd?: string,
): string
{
    const root = cwd === undefined
        ? commonSourceDirectory(matches.map((match) => match.source))
        : path.resolve(cwd);
    const identity = matches.map((match) => ({
        match,
        source: path.relative(root, path.resolve(match.source)),
    })).sort((left, right) => left.source.localeCompare(right.source) || compareMatches(left.match, right.match)).map((
        { match, source },
    ) => [
        source,
        match.lineNumber,
        match.startColumn,
        match.endColumn,
        match.matchedText,
        match.lineText,
    ]);
    return createHash("sha256")
        .update(JSON.stringify([query, identity]))
        .digest("hex")
        .slice(0, 8)
        .toUpperCase();
}

export class SearchSessionStore
{
    readonly #sessions = new Map<string, StoredSearchSession>();

    public async register(
        query: string,
        sourceMatches: readonly TextSearchMatch[],
        complete: boolean,
        cwd: string,
        signal?: AbortSignal,
    ): Promise<TextSearchSession>
    {
        const matches = sourceMatches.map((match) => ({ ...match, source: path.resolve(match.source) }))
            .sort(compareMatches);
        const contentBySource = new Map<string, string>();
        const matchesBySource = groupMatches(matches);

        for (const [source, sourceGroup] of matchesBySource)
        {
            const content = await readFile(source, { encoding: "utf8", ...(signal === undefined ? {} : { signal }) });
            const document = createTextDocument(source, content);

            for (const match of sourceGroup)
            {
                const line = document.lines[match.lineNumber - 1]?.content;

                if (
                    line !== match.lineText
                    || line.slice(match.startColumn, match.endColumn) !== match.matchedText
                )
                {
                    throw new Error(`Search result in ${source} changed before its anchors were registered.`);
                }
            }

            contentBySource.set(source, content);
        }

        const session: StoredSearchSession = {
            id: createSearchSessionId(query, matches, cwd),
            query,
            matches,
            complete,
            contentBySource,
        };
        this.#sessions.set(session.id, session);
        return session;
    }

    public anchorResolver(): TextAnchorResolver
    {
        return {
            id: "search",
            description: [
                "`SEARCH#HASH:N` selects one exact text match; `SEARCH#HASH:all` selects all matches.",
                "Omit `path` when `all` spans files.",
            ].join("\n"),
            tryResolve: (value, context) => this.#resolveAnchor(value, context.source, context.signal),
        };
    }

    public resourceResolver(): TextAnchorResourceResolver
    {
        return {
            tryResolve: (value, context) => this.#resolveResources(value, context.cwd),
        };
    }

    async #resolveAnchor(
        value: string,
        contextSource: string,
        signal?: AbortSignal,
    ): Promise<TextAnchorResolutionAttempt>
    {
        const parsed = parseSearchAnchor(value);

        if (parsed === undefined)
        {
            return { kind: "not-handled" };
        }

        const session = this.#sessions.get(parsed.id);

        if (session === undefined)
        {
            return staleAnchor();
        }

        if (parsed.selector === "all" && !session.complete)
        {
            return missingCompleteAnchor();
        }

        const selected = selectMatches(session, parsed.selector);
        const source = path.resolve(contextSource);
        const sourceMatches = selected.filter((match) => match.source === source);

        if (sourceMatches.length === 0)
        {
            return {
                kind: "rejected",
                rejection: { code: "missing", reason: "search anchor does not select this resource" },
            };
        }

        let current: string;

        try
        {
            current = await readFile(source, { encoding: "utf8", ...(signal === undefined ? {} : { signal }) });
        }
        catch
        {
            return staleAnchor(sourceMatches[0]!.lineNumber);
        }

        if (current !== session.contentBySource.get(source))
        {
            return staleAnchor(sourceMatches[0]!.lineNumber);
        }

        return {
            kind: "resolved",
            anchor: new TextSelectionAnchor(
                value,
                source,
                sourceMatches.map((match) => ({
                    start: { lineNumber: match.lineNumber, column: match.startColumn },
                    end: { lineNumber: match.lineNumber, column: match.endColumn },
                })),
            ),
        };
    }

    #resolveResources(value: string, cwd: string): TextAnchorResourceResolutionAttempt
    {
        const parsed = parseSearchAnchor(value);

        if (parsed === undefined)
        {
            return { kind: "not-handled" };
        }

        const session = this.#sessions.get(parsed.id);

        if (session === undefined)
        {
            return staleAnchor();
        }

        if (parsed.selector === "all" && !session.complete)
        {
            return missingCompleteAnchor();
        }

        const sources = [...new Set(selectMatches(session, parsed.selector).map((match) => match.source))]
            .map((source) => displaySource(source, cwd));
        return sources.length === 0
            ? { kind: "rejected", rejection: { code: "missing", reason: "search anchor has no matches" } }
            : { kind: "resolved", sources };
    }
}

function parseSearchAnchor(value: string): ParsedSearchAnchor | undefined
{
    const match = searchAnchorPattern.exec(value);

    if (match === null)
    {
        return undefined;
    }

    return { id: match[1]!, selector: match[2] === "all" ? "all" : Number(match[2]) };
}

function selectMatches(session: StoredSearchSession, selector: "all" | number): readonly TextSearchMatch[]
{
    if (selector === "all")
    {
        return session.matches;
    }

    const match = session.matches[selector - 1];
    return match === undefined ? [] : [match];
}

function groupMatches(matches: readonly TextSearchMatch[]): ReadonlyMap<string, readonly TextSearchMatch[]>
{
    const groups = new Map<string, TextSearchMatch[]>();

    for (const match of matches)
    {
        groups.set(match.source, [...(groups.get(match.source) ?? []), match]);
    }

    return groups;
}

function staleAnchor(lineNumber = 1): Extract<TextAnchorResolutionAttempt, { readonly kind: "rejected"; }>
{
    return {
        kind: "rejected",
        rejection: {
            code: "stale",
            reason: "search anchor is stale",
            contextRange: { offset: Math.max(1, lineNumber - 2), limit: 5 },
        },
    };
}

function missingCompleteAnchor(): Extract<TextAnchorResolutionAttempt, { readonly kind: "rejected"; }>
{
    return {
        kind: "rejected",
        rejection: { code: "missing", reason: "search did not register an all anchor because its result was limited" },
    };
}

function displaySource(source: string, cwd: string): string
{
    const relative = path.relative(cwd, source);
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : source;
}

function commonSourceDirectory(sources: readonly string[]): string
{
    if (sources.length === 0)
    {
        return ".";
    }

    let common = path.dirname(path.resolve(sources[0]!));

    for (const source of sources.slice(1))
    {
        const absolute = path.resolve(source);

        while (!isWithin(common, absolute))
        {
            const parent = path.dirname(common);

            if (parent === common)
            {
                return common;
            }

            common = parent;
        }
    }

    return common;
}

function isWithin(directory: string, source: string): boolean
{
    const relative = path.relative(directory, source);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function compareMatches(left: TextSearchMatch, right: TextSearchMatch): number
{
    return left.source.localeCompare(right.source)
        || left.lineNumber - right.lineNumber
        || left.startColumn - right.startColumn
        || left.endColumn - right.endColumn;
}
