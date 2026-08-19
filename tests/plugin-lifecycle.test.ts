import { expect, test } from "vitest";

import { connectIdePlugin } from "#src/api/connect-plugin.js";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdePlugin } from "#src/api/plugin-protocol.js";
import { createIdeCore } from "#src/core/ide-core.js";
import { listRegistered, resetRegistry } from "#src/toolchain/registry.js";
import registerPiAgentIde from "#src/core/extension.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IdeTool } from "#src/toolchain/types.js";

for (const order of ["core-first", "plugin-first"] as const)
{
    test(`connects an IDE plugin when loaded ${order}`, async () =>
    {
        const environment = createExtensionEnvironment();
        const core = environment.createExtension();
        const plugin = environment.createExtension();

        if (order === "core-first")
        {
            await registerPiAgentIde(core.pi);
            await connectIdePlugin(plugin.pi, createPlugin("fixture"));
        }
        else
        {
            connectIdePlugin(plugin.pi, createPlugin("fixture"));
            await registerPiAgentIde(core.pi);
        }

        expect(listRegistered().formatters.map(({ name }) => name)).toEqual(["fixture"]);
        await plugin.shutdown();
        await core.shutdown();
    });
}

test("does not commit tools from a failed IDE plugin setup", async () =>
{
    resetRegistry();
    const core = createIdeCore();
    const plugin = createPlugin("failed", () =>
    {
        throw new Error("setup failed");
    });

    await expect(core.registerPlugin(plugin)).rejects.toThrow("setup failed");
    expect(listRegistered().formatters).toEqual([]);
    resetRegistry();
});

function createPlugin(id: string, afterAdd?: () => void): IdePlugin
{
    const formatter = {
        kind: "formatter",
        name: id,
        priority: 100,
        extensions: ["*"],
        detect: () => Promise.resolve(true),
        format: () => Promise.resolve({ ok: true, edits: 0 }),
    } satisfies IdeTool;

    return {
        protocol: IDE_PROTOCOL,
        apiVersion: IDE_API_VERSION,
        id,
        setup(api): void
        {
            api.addTool(formatter);
            afterAdd?.();
        },
    };
}

interface TestExtension
{
    readonly pi: ExtensionAPI;
    shutdown(): Promise<void>;
}

function createExtensionEnvironment(): { createExtension(): TestExtension; }
{
    type EventListener = (value: unknown) => void;
    type LifecycleHandler = (event: unknown, context: unknown) => unknown;

    const listeners = new Map<string, Set<EventListener>>();
    const events = {
        on(event: string, listener: EventListener): () => void
        {
            const eventListeners = listeners.get(event) ?? new Set<EventListener>();
            eventListeners.add(listener);
            listeners.set(event, eventListeners);

            return () => eventListeners.delete(listener);
        },
        emit(event: string, value: unknown): void
        {
            for (const listener of [...(listeners.get(event) ?? [])])
            {
                listener(value);
            }
        },
    };

    return {
        createExtension(): TestExtension
        {
            const shutdownHandlers: LifecycleHandler[] = [];
            const pi = {
                events,
                on(event: string, handler: LifecycleHandler): void
                {
                    if (event === "session_shutdown")
                    {
                        shutdownHandlers.push(handler);
                    }
                },
                registerFlag(): void
                {},
            } as unknown as ExtensionAPI;

            return {
                pi,
                async shutdown(): Promise<void>
                {
                    for (const handler of shutdownHandlers)
                    {
                        await handler({ reason: "reload" }, {});
                    }
                },
            };
        },
    };
}
