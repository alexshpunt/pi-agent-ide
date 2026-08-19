import { createServer, type Server, type ServerResponse } from "node:http";

import { afterAll, beforeAll, expect, test } from "vitest";

import { type ContentRunner, createContentRunner } from "pi-agent-resource";
import { createTextContentConverter } from "pi-agent-text";

import { createWebResolver } from "#src/resolver.js";

const requestCounts = new Map<string, number>();
let server: Server;
let baseUrl: string;

beforeAll(async () =>
{
    server = createServer((request, response) =>
    {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
        serve(pathname, response);
    });
    await new Promise<void>((resolve, reject) =>
    {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();

    if (address === null || typeof address === "string")
    {
        throw new Error("Local web fixture server has no TCP address");
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () =>
{
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
    {
        server.close((error) => error === undefined ? resolve() : reject(error));
    });
});

test("recognizes only HTTP sources without performing I/O during resolution", async () =>
{
    const resolver = createWebResolver(webRunner());
    const before = totalRequests();

    await expect(resolver.tryResolve("ftp://example.test/file", { cwd: "/workspace" }))
        .resolves.toEqual({ kind: "not-handled" });
    const malformed = await resolver.tryResolve("http://", { cwd: "/workspace" });
    expect(malformed.kind).toBe("failed");
    expect(totalRequests()).toBe(before);

    const resolved = await resolver.tryResolve(`${baseUrl}/text`, { cwd: "/workspace" });
    expect(resolved.kind).toBe("resolved");

    if (resolved.kind !== "resolved")
    {
        throw new Error("Web resolver did not resolve an HTTP URL");
    }

    expect(resolved.resource.write).toBeUndefined();
});

test("performs one GET for one Resource read", async () =>
{
    const resolver = createWebResolver(webRunner());
    const attempt = await resolver.tryResolve(`${baseUrl}/text`, { cwd: "/workspace" });

    if (attempt.kind !== "resolved" || attempt.resource.read === undefined)
    {
        throw new Error("Web resolver did not return a readable Resource");
    }

    const before = requestCounts.get("/text") ?? 0;
    await expect(attempt.resource.read({})).resolves.toEqual([
        { type: "text", text: "first\nsecond\nthird\n" },
    ]);
    expect(requestCounts.get("/text")).toBe(before + 1);
});

test("honors caller cancellation and the configured timeout", async () =>
{
    const cancellationResolver = createWebResolver(webRunner(), { timeoutMs: 1000 });
    const cancellationAttempt = await cancellationResolver.tryResolve(`${baseUrl}/slow`, { cwd: "/workspace" });

    if (cancellationAttempt.kind !== "resolved" || cancellationAttempt.resource.read === undefined)
    {
        throw new Error("Cancellation fixture did not resolve");
    }

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(cancellationAttempt.resource.read({ signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
    });

    const timeoutResolver = createWebResolver(webRunner(), { timeoutMs: 20 });
    const timeoutAttempt = await timeoutResolver.tryResolve(`${baseUrl}/slow`, { cwd: "/workspace" });

    if (timeoutAttempt.kind !== "resolved" || timeoutAttempt.resource.read === undefined)
    {
        throw new Error("Timeout fixture did not resolve");
    }

    await expect(timeoutAttempt.resource.read({})).rejects.toMatchObject({ name: "TimeoutError" });
});

function webRunner(): ContentRunner
{
    const target = { provider: "web", capability: "read" } as const;
    const runner = createContentRunner(target);
    runner.register({ target, converter: createTextContentConverter(), priority: 100 });
    return runner;
}

function serve(pathname: string, response: ServerResponse): void
{
    if (pathname === "/text")
    {
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("first\nsecond\nthird\n");
        return;
    }

    if (pathname === "/slow")
    {
        setTimeout(() =>
        {
            if (!response.destroyed)
            {
                response.writeHead(200, { "Content-Type": "text/plain" });
                response.end("late");
            }
        }, 250);
        return;
    }

    response.writeHead(404);
    response.end("missing");
}

function totalRequests(): number
{
    return [...requestCounts.values()].reduce((total, count) => total + count, 0);
}
