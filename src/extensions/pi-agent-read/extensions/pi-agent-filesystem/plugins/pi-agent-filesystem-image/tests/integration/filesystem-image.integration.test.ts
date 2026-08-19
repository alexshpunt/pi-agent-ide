import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { createContentHost, UnsupportedContentError } from "pi-agent-resource";

import registerFilesystemImage from "#extension";

const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);

test("registers image conversion only for filesystem reads", async () =>
{
    const pi = createExtensionApi();
    await registerFilesystemImage(pi);
    const writeHost = createContentHost(pi, { provider: "filesystem", capability: "write" });
    const readHost = createContentHost(pi, { provider: "filesystem", capability: "read" });
    const input = { source: "/fixture/image.png", bytes: png };

    await expect(readHost.convert(input, {})).resolves.toMatchObject({
        0: { type: "text", text: "Read image [image/png]" },
        1: { type: "image", mimeType: "image/png" },
    });
    await expect(writeHost.convert(input, {})).rejects.toBeInstanceOf(UnsupportedContentError);
});

function createExtensionApi(): ExtensionAPI
{
    type Listener = (value: unknown) => void;
    const listeners = new Map<string, Set<Listener>>();
    const events = {
        on(event: string, listener: Listener): () => void
        {
            const eventListeners = listeners.get(event) ?? new Set<Listener>();
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

    return { events, on: events.on } as unknown as ExtensionAPI;
}
