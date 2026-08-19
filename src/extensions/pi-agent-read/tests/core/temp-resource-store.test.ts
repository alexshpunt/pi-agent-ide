import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { TempResourceStore } from "#src/core/tools/read/temp-resource-store.js";

const stores: TempResourceStore[] = [];
const directories: string[] = [];

afterEach(async () =>
{
    vi.useRealTimers();
    await Promise.all(stores.splice(0).map((store) => store.dispose()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("keeps a temporary resource alive while it is read and expires it after inactivity", async () =>
{
    vi.useFakeTimers();
    const parentDirectory = await mkdtemp(path.join(tmpdir(), "pi-agent-read-temp-test-"));
    directories.push(parentDirectory);
    const store = new TempResourceStore({ parentDirectory, ttlMs: 5 * 60_000 });
    stores.push(store);
    const source = await store.save("alpha\nbravo\ncharlie");

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(await readTemporarySource(store, source)).toBe("alpha\nbravo\ncharlie");

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(await readTemporarySource(store, source)).toBe("alpha\nbravo\ncharlie");

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    const expired = await store.resolver.tryResolve(source, { cwd: "/workspace" });
    expect(expired).toMatchObject({ kind: "failed" });
});

async function readTemporarySource(store: TempResourceStore, source: string): Promise<string>
{
    const attempt = await store.resolver.tryResolve(source, { cwd: "/workspace" });

    if (attempt.kind !== "resolved" || attempt.resource.read === undefined)
    {
        throw new Error(`Unable to resolve ${source}`);
    }

    const content = await attempt.resource.read({});
    const block = content[0];

    if (block?.type !== "text")
    {
        throw new Error(`Temporary resource ${source} did not contain text`);
    }

    return block.text;
}
