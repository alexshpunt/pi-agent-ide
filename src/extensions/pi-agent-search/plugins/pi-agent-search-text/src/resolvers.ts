import path from "node:path";

import { searchFiles } from "#src/file-search.js";
import { searchText } from "#src/search-backend.js";
import { compileSearchQuery } from "#src/search-query.js";
import { renderSearchResult } from "#src/search-renderer.js";
import { createSearchToolDetails } from "#src/search-result.js";

import type { SearchSessionStore, TextSearchMatch, TextSearchSession } from "#src/search-session.js";
import type { SearchRequest, SearchResolver } from "pi-agent-search/api/search";

interface TextPayload
{
    readonly request: SearchRequest;
    readonly matches: readonly TextSearchMatch[];
    readonly complete: boolean;
}

interface FilePayload
{
    readonly query: string;
    readonly files: readonly string[];
    readonly complete: boolean;
}

const explicitPrefixes = ["regex:", "files:", "semantic:", "web:", "lsp:", "ast:"] as const;

export function createTextResolver(sessions: SearchSessionStore): SearchResolver
{
    return createMatchResolver(
        "text",
        sessions,
        (query) => explicitPrefixes.some((prefix) => query.startsWith(prefix)) ? undefined : compileSearchQuery(query),
    );
}

export function createRegexResolver(sessions: SearchSessionStore): SearchResolver
{
    return createMatchResolver(
        "regex",
        sessions,
        (query) => query.startsWith("regex:") ? query.slice("regex:".length) : undefined,
    );
}

export function createFileResolver(): SearchResolver
{
    return {
        id: "files",
        async tryResolve(request, context)
        {
            if (!request.query.startsWith("files:"))
            {
                return { kind: "not-handled" };
            }

            const query = request.query.slice("files:".length).trim();
            const result = await searchFiles(query, request, context.cwd, context.signal);
            return { kind: "resolved", payload: { query, ...result } satisfies FilePayload };
        },
        format(payload)
        {
            const result = payload as FilePayload;
            const heading = result.complete
                ? `${String(result.files.length)} files`
                : `${String(result.files.length)}+ files (limit reached)`;
            return {
                content: [{ type: "text", text: [heading, ...result.files].join("\n") }],
                details: { query: result.query, files: result.files, complete: result.complete },
            };
        },
    };
}

function createMatchResolver(
    id: "text" | "regex",
    sessions: SearchSessionStore,
    queryBody: (query: string) => string | undefined,
): SearchResolver
{
    return {
        id,
        async tryResolve(request, context)
        {
            const query = queryBody(request.query);

            if (query === undefined)
            {
                return { kind: "not-handled" };
            }

            if (query.length === 0)
            {
                return { kind: "failed", error: new Error(`${id} search query must not be empty`) };
            }

            const result = await searchText({ ...request, query, regex: true }, context.cwd, context.signal);
            return { kind: "resolved", payload: { request: { ...request, query }, ...result } satisfies TextPayload };
        },
        async format(payload, context)
        {
            const result = payload as TextPayload;

            if (result.matches.length === 0)
            {
                return {
                    content: [{ type: "text", text: "No matches found." }],
                    details: createSearchToolDetails(result.request.query, [], result.complete, context.cwd),
                };
            }

            const session = await sessions.register(
                result.request.query,
                result.matches,
                result.complete,
                context.cwd,
                context.signal,
            );
            return {
                content: [{ type: "text", text: formatSearchSession(session, context.cwd) }],
                details: createSearchToolDetails(
                    session.query,
                    session.matches,
                    session.complete,
                    context.cwd,
                    session.id,
                ),
            };
        },
        renderResult: renderSearchResult as SearchResolver["renderResult"],
    };
}

function formatSearchSession(session: TextSearchSession, cwd: string): string
{
    const fileCount = new Set(session.matches.map((match) => match.source)).size;
    const count = session.matches.length;
    const heading = session.complete
        ? `SEARCH#${session.id}:all — ${String(count)} ${plural(count, "match", "matches")} in ${String(fileCount)} ${
            plural(fileCount, "file", "files")
        }`
        : `${String(count)}+ matches in ${String(fileCount)} ${
            plural(fileCount, "file", "files")
        } (limit reached; no all anchor was registered)`;
    const lines = [heading];
    let previousSource: string | undefined;

    for (const [index, match] of session.matches.entries())
    {
        if (previousSource !== undefined && previousSource !== match.source)
        {
            lines.push("");
        }

        const source = displaySource(match.source, cwd);
        lines.push(
            `${source}:${String(match.lineNumber)}:${String(match.startColumn + 1)}-${
                String(match.endColumn + 1)
            } SEARCH#${session.id}:${String(index + 1)}`,
            `  ${previewMatch(match)}`,
        );
        previousSource = match.source;
    }

    if (!session.complete)
    {
        lines.push("", "Increase limit and search again before applying a complete replacement.");
    }

    return lines.join("\n");
}

function previewMatch(match: TextSearchMatch): string
{
    const context = 64;
    const from = Math.max(0, match.startColumn - context);
    const to = Math.min(match.lineText.length, match.endColumn + context);
    return `${from > 0 ? "…" : ""}${match.lineText.slice(from, match.startColumn)}⟦${
        match.lineText.slice(match.startColumn, match.endColumn)
    }⟧${match.lineText.slice(match.endColumn, to)}${to < match.lineText.length ? "…" : ""}`;
}

function displaySource(source: string, cwd: string): string
{
    const relative = path.relative(cwd, source);
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : source;
}

function plural(count: number, singular: string, pluralForm: string): string
{
    return count === 1 ? singular : pluralForm;
}
