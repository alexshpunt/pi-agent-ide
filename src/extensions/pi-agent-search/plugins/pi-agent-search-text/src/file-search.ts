import { spawn } from "node:child_process";
import path from "node:path";

import type { SearchRequest } from "pi-agent-search/api/search";

export interface FileSearchResult
{
    readonly files: readonly string[];
    readonly complete: boolean;
}

export function searchFiles(
    query: string,
    request: SearchRequest,
    cwd: string,
    signal?: AbortSignal,
): Promise<FileSearchResult>
{
    const limit = request.limit ?? 100;
    const args = ["--files", "--hidden", "--no-config", "--no-ignore-parent", "--glob", "!.git/**"];

    for (const include of splitGlobs(request.include))
    {
        args.push("--glob", include);
    }

    for (const exclude of splitGlobs(request.exclude))
    {
        args.push("--glob", `!${exclude}`);
    }

    if (request.path !== undefined)
    {
        args.push(request.path);
    }

    return new Promise((resolve, reject) =>
    {
        const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => stdout += chunk);
        child.stderr.on("data", (chunk: string) => stderr += chunk);
        const abort = (): void =>
        {
            child.kill("SIGTERM");
        };
        signal?.addEventListener("abort", abort, { once: true });
        child.once("error", reject);
        child.once("close", (code) =>
        {
            signal?.removeEventListener("abort", abort);

            if (signal?.aborted === true)
            {
                reject(signal.reason instanceof Error ? signal.reason : new Error("File search aborted"));
                return;
            }

            if (code !== 0 && code !== 1)
            {
                reject(new Error(stderr.trim() || `rg exited with code ${String(code)}`));
                return;
            }

            const matches = stdout.split("\n").filter(Boolean)
                .map((file) => path.relative(cwd, path.resolve(cwd, file)))
                .filter((file) => fuzzyMatch(file, query))
                .sort((left, right) => left.localeCompare(right));
            resolve({ files: matches.slice(0, limit), complete: matches.length <= limit });
        });
    });
}

function splitGlobs(value: string | undefined): string[]
{
    return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function fuzzyMatch(file: string, query: string): boolean
{
    if (query.length === 0)
    {
        return true;
    }

    let index = 0;
    const candidate = file.toLowerCase();

    for (const character of query.toLowerCase())
    {
        index = candidate.indexOf(character, index);

        if (index === -1)
        {
            return false;
        }

        index += 1;
    }

    return true;
}
