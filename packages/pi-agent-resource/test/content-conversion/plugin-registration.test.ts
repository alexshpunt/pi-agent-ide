import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import {
    connectContentConverter,
    type ContentConverterRegistration,
    type ContentTarget,
    createContentHost,
    UnsupportedContentError,
} from "pi-agent-resource";

const readTarget = { provider: "fixture", capability: "read" } satisfies ContentTarget;
const writeTarget = { provider: "fixture", capability: "write" } satisfies ContentTarget;
const input = { source: "fixture://value", bytes: new Uint8Array(0) };

test.each(["provider-first", "adapter-first"] as const)(
    "registers exactly once when loaded %s",
    async (order) =>
    {
        const pi = createExtensionApi();
        const registration = textRegistration(readTarget);
        let host: ReturnType<typeof createContentHost>;

        if (order === "provider-first")
        {
            host = createContentHost(pi, readTarget);
            await connectContentConverter(pi, registration);
        }
        else
        {
            expect(connectContentConverter(pi, registration)).toBeUndefined();
            host = createContentHost(pi, readTarget);
        }

        await expect(host.convert(input, {})).resolves.toEqual([{ type: "text", text: "fixture" }]);
        await expect(host.convert(input, {})).resolves.toEqual([{ type: "text", text: "fixture" }]);
    },
);

test("keeps registrations isolated by exact target", async () =>
{
    const pi = createExtensionApi();
    const readHost = createContentHost(pi, readTarget);
    const writeHost = createContentHost(pi, writeTarget);

    await connectContentConverter(pi, textRegistration(readTarget));
    expect(readHost.listDescriptions()).toEqual([{ id: "text", description: "UTF-8 text." }]);
    expect(writeHost.listDescriptions()).toEqual([]);

    await expect(readHost.convert(input, {})).resolves.toEqual([{ type: "text", text: "fixture" }]);
    await expect(writeHost.convert(input, {})).rejects.toBeInstanceOf(UnsupportedContentError);
});

test("detaches accepted hosts before registering the reloaded converter", async () =>
{
    const environment = createExtensionEnvironment();
    const oldProvider = environment.createExtension();
    const oldAdapter = environment.createExtension();
    const oldHost = createContentHost(oldProvider.pi, readTarget);

    await connectContentConverter(oldAdapter.pi, textRegistration(readTarget, "old"));
    await expect(oldHost.convert(input, {})).resolves.toEqual([{ type: "text", text: "old" }]);

    await oldAdapter.shutdown();
    await oldProvider.shutdown();

    const currentProvider = environment.createExtension();
    const currentAdapter = environment.createExtension();
    const currentHost = createContentHost(currentProvider.pi, readTarget);

    await connectContentConverter(currentAdapter.pi, textRegistration(readTarget, "current"));
    await expect(currentHost.convert(input, {})).resolves.toEqual([{ type: "text", text: "current" }]);
});

test("detaches adapters still waiting for a host before reload", async () =>
{
    const environment = createExtensionEnvironment();
    const oldAdapter = environment.createExtension();

    expect(connectContentConverter(oldAdapter.pi, textRegistration(readTarget, "old"))).toBeUndefined();
    await oldAdapter.shutdown();

    const currentProvider = environment.createExtension();
    const currentHost = createContentHost(currentProvider.pi, readTarget);
    const currentAdapter = environment.createExtension();

    await connectContentConverter(currentAdapter.pi, textRegistration(readTarget, "current"));
    await expect(currentHost.convert(input, {})).resolves.toEqual([{ type: "text", text: "current" }]);
});

function textRegistration(target: ContentTarget, resultText = "fixture"): ContentConverterRegistration
{
    return {
        target,
        converter: {
            id: "text",
            description: "UTF-8 text.",
            async tryConvert()
            {
                return { kind: "converted", content: [{ type: "text", text: resultText }] };
            },
        },
    };
}

interface TestExtension
{
    readonly pi: ExtensionAPI;
    shutdown(): Promise<void>;
}

function createExtensionApi(): ExtensionAPI
{
    return createExtensionEnvironment().createExtension().pi;
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
