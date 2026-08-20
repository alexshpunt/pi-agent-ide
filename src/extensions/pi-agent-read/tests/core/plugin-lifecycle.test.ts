import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { connectReadPlugin } from "#src/api/connect-plugin.js";
import { READ_API_VERSION, READ_PROTOCOL, type ReadPlugin } from "#src/api/plugin-protocol.js";
import registerReadCore from "#src/core/extension.js";

test("reload detaches the previous read core registration listener", async () => {
  const environment = createExtensionEnvironment();
  const oldCore = environment.createExtension();
  const oldPlugin = environment.createExtension();

  await registerReadCore(oldCore.pi);
  await connectReadPlugin(oldPlugin.pi, createPlugin("fixture"));
  await oldPlugin.shutdown();
  await oldCore.shutdown();

  const currentCore = environment.createExtension();
  const currentPlugin = environment.createExtension();

  await registerReadCore(currentCore.pi);
  await expect(connect(currentPlugin.pi, createPlugin("fixture"))).resolves.toBeUndefined();
});

test("reload detaches read plugins still waiting for a core", async () => {
  const environment = createExtensionEnvironment();
  const oldPlugin = environment.createExtension();

  expect(connectReadPlugin(oldPlugin.pi, createPlugin("fixture"))).toBeUndefined();
  await oldPlugin.shutdown();

  const currentCore = environment.createExtension();
  const currentPlugin = environment.createExtension();

  await registerReadCore(currentCore.pi);
  await expect(connect(currentPlugin.pi, createPlugin("fixture"))).resolves.toBeUndefined();
});

async function connect(pi: ExtensionAPI, plugin: ReadPlugin): Promise<void> {
  await connectReadPlugin(pi, plugin);
}

function createPlugin(id: string): ReadPlugin {
  return {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id,
    setup(): void {},
  };
}

interface TestExtension {
  readonly pi: ExtensionAPI;
  shutdown(): Promise<void>;
}

function createExtensionEnvironment(): { createExtension(): TestExtension } {
  type EventListener = (value: unknown) => void;
  type LifecycleHandler = (event: unknown, context: unknown) => unknown;

  const listeners = new Map<string, Set<EventListener>>();
  const events = {
    on(event: string, listener: EventListener): () => void {
      const eventListeners = listeners.get(event) ?? new Set<EventListener>();
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

  return {
    createExtension(): TestExtension {
      const shutdownHandlers: LifecycleHandler[] = [];
      const pi = asExtensionApi({
        events,
        on(event: string, handler: LifecycleHandler): void {
          if (event === "session_shutdown") {
            shutdownHandlers.push(handler);
          }
        },
        registerTool(): void {},
        registerMessageRenderer(): void {},
        registerEntryRenderer(): void {},
        sendMessage(): void {},
      });

      return {
        pi,
        async shutdown(): Promise<void> {
          for (const handler of shutdownHandlers) {
            await handler({ reason: "reload" }, {});
          }
        },
      };
    },
  };
}

function asExtensionApi(value: unknown): ExtensionAPI {
  return value as ExtensionAPI;
}
