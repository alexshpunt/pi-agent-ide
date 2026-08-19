import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { connectTextEditorPlugin } from "#src/api/connect-plugin.js";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL, type TextEditorPlugin } from "#src/api/plugin-protocol.js";
import registerTextEditorCore from "#src/core/extension.js";

test("reload detaches the previous text editor core registration listener", async () =>
{
    const environment = createExtensionEnvironment();
    const oldCore = environment.createExtension();
    const oldPlugin = environment.createExtension();

    await registerTextEditorCore(oldCore.pi);
    await connectTextEditorPlugin(oldPlugin.pi, createPlugin("fixture"));
    await oldPlugin.shutdown();
    await oldCore.shutdown();

    const currentCore = environment.createExtension();
    const currentPlugin = environment.createExtension();

    await registerTextEditorCore(currentCore.pi);
    await expect(connect(currentPlugin.pi, createPlugin("fixture"))).resolves.toBeUndefined();
});

test("reload detaches text editor plugins still waiting for a core", async () =>
{
    const environment = createExtensionEnvironment();
    const oldPlugin = environment.createExtension();

    expect(connectTextEditorPlugin(oldPlugin.pi, createPlugin("fixture"))).toBeUndefined();
    await oldPlugin.shutdown();

    const currentCore = environment.createExtension();
    const currentPlugin = environment.createExtension();

    await registerTextEditorCore(currentCore.pi);
    await expect(connect(currentPlugin.pi, createPlugin("fixture"))).resolves.toBeUndefined();
});

async function connect(pi: ExtensionAPI, plugin: TextEditorPlugin): Promise<void>
{
    await connectTextEditorPlugin(pi, plugin);
}

function createPlugin(id: string): TextEditorPlugin
{
    return {
        protocol: TEXT_EDITOR_PROTOCOL,
        apiVersion: TEXT_EDITOR_API_VERSION,
        id,
        setup(): void
        {},
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
