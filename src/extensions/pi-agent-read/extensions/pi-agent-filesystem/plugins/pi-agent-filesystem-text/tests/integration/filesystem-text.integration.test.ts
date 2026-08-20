import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { createContentHost } from "pi-agent-resource";

import registerFilesystemText from "#extension";

test("registers text conversion for both filesystem capabilities", async () => {
  const pi = createExtensionApi();
  await registerFilesystemText(pi);
  const readHost = createContentHost(pi, { provider: "filesystem", capability: "read" });
  const writeHost = createContentHost(pi, { provider: "filesystem", capability: "write" });
  const input = {
    source: "/fixture/value.txt",
    bytes: new TextEncoder().encode("fixture text"),
  };

  await expect(readHost.convert(input, {})).resolves.toEqual([
    { type: "text", text: "fixture text" },
  ]);
  await expect(writeHost.convert(input, {})).resolves.toEqual([
    { type: "text", text: "fixture text" },
  ]);
});

function createExtensionApi(): ExtensionAPI {
  type Listener = (value: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();
  const events = {
    on(event: string, listener: Listener): () => void {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(listener);
    },
    emit(event: string, value: unknown): void {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(value);
      }
    },
  };

  return asExtensionApi({ events, on: events.on });
}

function asExtensionApi(value: unknown): ExtensionAPI {
  return value as ExtensionAPI;
}
