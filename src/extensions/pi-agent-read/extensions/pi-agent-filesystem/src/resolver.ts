import { readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { textFromAgentContent } from "pi-agent-text";

import type {
    ContentHost,
    ResourceResolutionAttempt,
    ResourceResolver,
    ResourceResolverContext,
} from "pi-agent-resource";

type FilesystemContentHost = Pick<ContentHost, "convert">;
type FilesystemCapability = "read" | "write";

export function createFilesystemReadResolver(contentHost: FilesystemContentHost): ResourceResolver
{
    return createFilesystemResolver("read", contentHost);
}

export function createFilesystemWriteResolver(contentHost: FilesystemContentHost): ResourceResolver
{
    return createFilesystemResolver("write", contentHost);
}

function createFilesystemResolver(
    capability: FilesystemCapability,
    contentHost: FilesystemContentHost,
): ResourceResolver
{
    return {
        id: "filesystem",
        tryResolve(source, context)
        {
            return Promise.resolve(resolveFilesystemSource(source, context, capability, contentHost));
        },
    };
}

function resolveFilesystemSource(
    source: string,
    context: ResourceResolverContext,
    capability: FilesystemCapability,
    contentHost: FilesystemContentHost,
): ResourceResolutionAttempt
{
    if (source.length === 0)
    {
        return { kind: "failed", error: new TypeError("Filesystem source must not be empty") };
    }

    if (!isFilesystemSource(source))
    {
        return { kind: "not-handled" };
    }

    if (context.signal?.aborted === true)
    {
        return { kind: "failed", error: abortError() };
    }

    const filePath = source.startsWith("file://")
        ? realpathSync(fileURLToPath(new URL(source)))
        : path.resolve(context.cwd, source);
    const link = pathToFileURL(filePath).href;
    const directory = (() =>
    {
        try
        {
            return statSync(filePath).isDirectory();
        }
        catch
        {
            return false;
        }
    })();
    const read = async ({ signal }: { readonly signal?: AbortSignal; }) =>
        directory ? readDirectoryContent(filePath, signal) : readFilesystemContent(filePath, contentHost, signal);

    if (capability === "read" || directory)
    {
        return { kind: "resolved", resource: { source: filePath, link, read } };
    }

    return {
        kind: "resolved",
        resource: {
            source: filePath,
            link,
            read,
            async write(content, operationContext)
            {
                throwIfAborted(operationContext.signal);
                const text = textFromAgentContent(content);
                await mkdir(path.dirname(filePath), { recursive: true });
                throwIfAborted(operationContext.signal);
                await writeFile(filePath, text, {
                    encoding: "utf8",
                    ...(operationContext.signal === undefined ? {} : { signal: operationContext.signal }),
                });
            },
        },
    };
}

function readDirectoryContent(filePath: string, signal: AbortSignal | undefined)
{
    throwIfAborted(signal);

    const entries = readdirSync(filePath, { withFileTypes: true });
    const lines = [`📁 ${filePath}/`];

    if (entries.length > 0)
    {
        lines.push("");
    }

    for (const entry of entries)
    {
        const icon = entry.isDirectory() ? "📁" : entry.isFile() ? "📄" : "🔗";
        lines.push(`  ${icon} ${entry.name}`);
    }

    return [{ type: "text" as const, text: lines.join("\n") }] as const;
}

async function readFilesystemContent(
    filePath: string,
    contentHost: FilesystemContentHost,
    signal: AbortSignal | undefined,
)
{
    throwIfAborted(signal);
    const bytes = await readFile(filePath, {
        encoding: null,
        ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(signal);
    return contentHost.convert(
        { source: filePath, bytes },
        signal === undefined ? {} : { signal },
    );
}

function isFilesystemSource(source: string): boolean
{
    if (/^[A-Za-z]:[\\/]/u.test(source))
    {
        return true;
    }

    if (source.startsWith("file://"))
    {
        return true;
    }

    return !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(source);
}

function throwIfAborted(signal: AbortSignal | undefined): void
{
    if (signal?.aborted === true)
    {
        throw abortError();
    }
}

function abortError(): Error
{
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}
