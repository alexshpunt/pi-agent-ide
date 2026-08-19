import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

import type { TextSearchMatch } from "#src/search-session.js";

export interface TextSearchRequest
{
    readonly query: string;
    readonly path?: string;
    readonly include?: string;
    readonly exclude?: string;
    readonly regex?: boolean;
    readonly caseSensitive?: boolean;
    readonly wholeWord?: boolean;
    readonly limit?: number;
}

export interface TextSearchBackendResult
{
    readonly matches: readonly TextSearchMatch[];
    readonly complete: boolean;
}

interface RipgrepMatchEvent
{
    readonly type: "match";
    readonly data: {
        readonly path: { readonly text?: string; };
        readonly lines: { readonly text?: string; };
        readonly line_number: number;
        readonly submatches: readonly {
            readonly start: number;
            readonly end: number;
        }[];
    };
}

export async function searchText(
    request: TextSearchRequest,
    cwd: string,
    signal?: AbortSignal,
): Promise<TextSearchBackendResult>
{
    if (request.query.length === 0)
    {
        throw new Error("Search query must not be empty.");
    }

    if (/\r|\n/u.test(request.query))
    {
        throw new Error("Search supports one-line patterns only.");
    }

    const limit = request.limit ?? 100;
    const target = path.resolve(cwd, stripFilePrefix(request.path ?? "."));
    const commonArgs = [
        "--json",
        "--no-config",
        "--no-ignore-parent",
        "--color=never",
        "--with-filename",
        "--line-number",
        request.caseSensitive === true ? "--case-sensitive" : "--ignore-case",
        ...(request.wholeWord === true ? ["--word-regexp"] : []),
        ...splitGlobList(request.include).flatMap((glob) => ["--glob", glob]),
        ...splitGlobList(request.exclude).flatMap((glob) => ["--glob", `!${glob}`]),
        "--",
        request.query,
        target,
    ];

    if (request.regex !== true)
    {
        return runRipgrep(["--fixed-strings", ...commonArgs], limit, signal);
    }

    try
    {
        return await runRipgrep(["--engine", "auto", ...commonArgs], limit, signal);
    }
    catch (error)
    {
        if (!isPcre2MatchLimitError(error))
        {
            throw error;
        }

        return runRipgrep(["--engine", "default", ...commonArgs], limit, signal);
    }
}

function runRipgrep(
    args: readonly string[],
    limit: number,
    signal?: AbortSignal,
): Promise<TextSearchBackendResult>
{
    return new Promise((resolve, reject) =>
    {
        const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
        const output = createInterface({ input: child.stdout });
        const matches: TextSearchMatch[] = [];
        let stderr = "";
        let stoppedAtLimit = false;
        let parseError: unknown;

        const abort = (): void =>
        {
            child.kill();
        };
        const cleanup = (): void =>
        {
            signal?.removeEventListener("abort", abort);
            output.close();
        };

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) =>
        {
            stderr += chunk;
        });
        output.on("line", (line) =>
        {
            if (stoppedAtLimit || parseError !== undefined || line.length === 0)
            {
                return;
            }

            try
            {
                const event = JSON.parse(line) as { readonly type?: unknown; };

                if (event.type !== "match")
                {
                    return;
                }

                for (const match of matchesFromEvent(event as RipgrepMatchEvent))
                {
                    if (matches.length === limit)
                    {
                        stoppedAtLimit = true;
                        child.kill();
                        return;
                    }

                    matches.push(match);
                }
            }
            catch (error)
            {
                parseError = error;
                child.kill();
            }
        });
        child.once("error", (error) =>
        {
            cleanup();
            reject(error);
        });
        child.once("close", (code) =>
        {
            cleanup();

            if (signal?.aborted === true)
            {
                const error = new Error("Search was aborted.");
                error.name = "AbortError";
                reject(error);
                return;
            }

            if (parseError !== undefined)
            {
                reject(new Error("Unable to parse ripgrep search output.", { cause: parseError }));
                return;
            }

            if (!stoppedAtLimit && code !== 0 && code !== 1)
            {
                reject(new Error(stderr.trim() || `ripgrep exited with code ${String(code)}.`));
                return;
            }

            matches.sort(compareMatches);
            resolve({ matches, complete: !stoppedAtLimit });
        });

        signal?.addEventListener("abort", abort, { once: true });

        if (signal?.aborted === true)
        {
            abort();
        }
    });
}

function isPcre2MatchLimitError(error: unknown): boolean
{
    return error instanceof Error && /PCRE2: error matching: match limit exceeded/iu.test(error.message);
}

function matchesFromEvent(event: RipgrepMatchEvent): TextSearchMatch[]
{
    const source = event.data.path.text;
    const rawLine = event.data.lines.text;

    if (source === undefined || rawLine === undefined || !Number.isSafeInteger(event.data.line_number))
    {
        return [];
    }

    const lineText = rawLine.replace(/(?:\r\n|\n)$/u, "");
    const lineBuffer = Buffer.from(rawLine);
    const matches: TextSearchMatch[] = [];

    for (const submatch of event.data.submatches)
    {
        if (submatch.start < 0 || submatch.end <= submatch.start || submatch.end > lineBuffer.length)
        {
            continue;
        }

        const startColumn = lineBuffer.subarray(0, submatch.start).toString("utf8").length;
        const endColumn = lineBuffer.subarray(0, submatch.end).toString("utf8").length;
        matches.push({
            source: path.resolve(source),
            lineNumber: event.data.line_number,
            startColumn,
            endColumn,
            matchedText: lineText.slice(startColumn, endColumn),
            lineText,
        });
    }

    return matches;
}

function splitGlobList(value: string | undefined): string[]
{
    if (value === undefined)
    {
        return [];
    }

    const globs: string[] = [];
    let depth = 0;
    let current = "";

    for (const character of value)
    {
        if (character === "{")
        {
            depth += 1;
        }
        else if (character === "}")
        {
            depth = Math.max(0, depth - 1);
        }

        if (depth === 0 && (character === "," || /\s/u.test(character)))
        {
            if (current.length > 0)
            {
                globs.push(current);
                current = "";
            }

            continue;
        }

        current += character;
    }

    if (current.length > 0)
    {
        globs.push(current);
    }

    return globs;
}

function stripFilePrefix(source: string): string
{
    return source.startsWith("@") ? source.slice(1) : source;
}

function compareMatches(left: TextSearchMatch, right: TextSearchMatch): number
{
    return left.source.localeCompare(right.source)
        || left.lineNumber - right.lineNumber
        || left.startColumn - right.startColumn
        || left.endColumn - right.endColumn;
}
