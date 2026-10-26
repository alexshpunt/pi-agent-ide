import {
  createAssistantMessageEventStream,
  type Provider,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { registerStreamingInterceptorProvider } from "#src/core/tool-call-interceptor/streaming-provider.js";

const model: Model<"openai-completions"> = {
  id: "fixture",
  name: "Fixture",
  provider: "native-fixture",
  api: "openai-completions",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1024,
  maxTokens: 128,
};

function staleContext(): never {
  throw new Error("This extension ctx is stale after session replacement or reload.");
}

function fixture() {
  const handlers = new Map<string, ((event: never, context: ExtensionContext) => unknown)[]>();
  const original: Provider = {
    id: model.provider,
    name: "Native OAuth fixture",
    auth: {
      oauth: {
        name: "Fixture OAuth",
        async login() {
          return {
            type: "oauth",
            access: "synthetic",
            refresh: "synthetic-refresh",
            expires: Date.now() + 60_000,
          };
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    getModels: () => [model],
    getAllModels: () => [model],
    refreshModels: vi.fn(async () => {}),
    filterModels: (models) => models,
    stream: () => createAssistantMessageEventStream(),
    streamSimple: () => createAssistantMessageEventStream(),
  };
  let current: Provider | undefined = original;
  let native: Provider | undefined = original;
  const unregisterProvider = vi.fn(() => {
    current = undefined;
    native = undefined;
  });
  function registerProvider(provider: Provider): void;
  function registerProvider(id: string, config: ProviderConfig): void;
  function registerProvider(provider: Provider | string, _config?: ProviderConfig): void {
    if (typeof provider === "string") {
      // Match Pi's registration boundary: a legacy config replaces a native registration.
      native = undefined;
      current = undefined;
    } else {
      current = provider;
      native = provider;
    }
  }
  const on: ExtensionAPI["on"] = (event, handler) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return () => {
      handlers.delete(event);
    };
  };
  const api = { on, registerProvider, unregisterProvider };
  const registryMethods = {
    getProvider: () => current,
    getRegisteredNativeProvider: () => native,
    getRegisteredProviderConfig: () => undefined,
  } satisfies Pick<
    ExtensionContext["modelRegistry"],
    "getProvider" | "getRegisteredNativeProvider" | "getRegisteredProviderConfig"
  >;
  const modelRegistry = Object.assign(
    Object.create(null) as ExtensionContext["modelRegistry"],
    registryMethods,
  );
  let stale = false;
  // Like Pi, every context field throws once the session that issued the context is disposed.
  const context = Object.create(null, {
    model: { get: () => (stale ? staleContext() : model) },
    modelRegistry: { get: () => (stale ? staleContext() : modelRegistry) },
  }) as ExtensionContext;
  const install = () =>
    registerStreamingInterceptorProvider(
      api,
      async () => undefined,
      () => {},
      () => {},
    );
  const emit = (event: string) => {
    for (const handler of handlers.get(event) ?? []) handler({ model } as never, context);
  };
  return {
    original,
    install,
    emit,
    current: () => current,
    registerProvider,
    unregisterProvider,
    dispose: () => {
      stale = true;
    },
  };
}

test("a native stream guard retains OAuth, model discovery and non-enumerable provider properties", () => {
  const run = fixture();
  Object.defineProperty(run.original, "baseUrl", {
    get: () => "https://native.invalid",
    enumerable: false,
  });
  run.install();
  run.emit("session_start");
  const wrapped = run.current();
  expect(wrapped?.auth).toBe(run.original.auth);
  expect(wrapped?.getAllModels).toBe(run.original.getAllModels);
  expect(wrapped?.refreshModels).toBe(run.original.refreshModels);
  expect(wrapped?.filterModels).toBe(run.original.filterModels);
  expect(wrapped?.stream).toBe(run.original.stream);
  expect(wrapped?.streamSimple).not.toBe(run.original.streamSimple);
  expect(wrapped?.baseUrl).toBe("https://native.invalid");
});

test("reinstalling a guard preserves a native provider's updated authentication and catalog", () => {
  const run = fixture();
  run.install();
  run.emit("session_start");
  const replacement: Provider = {
    ...run.original,
    name: "Updated native provider",
    auth: { ...run.original.auth },
  };
  run.registerProvider(replacement);
  run.emit("before_provider_request");
  expect(run.current()?.name).toBe(replacement.name);
  expect(run.current()?.auth).toBe(replacement.auth);
  expect(run.current()?.getModels).toBe(replacement.getModels);
  expect(run.current()?.streamSimple).not.toBe(replacement.streamSimple);
  run.emit("session_shutdown");
  expect(run.current()?.auth).toBe(replacement.auth);
  expect(run.current()?.streamSimple).toBe(run.original.streamSimple);
  expect(run.unregisterProvider).not.toHaveBeenCalled();
});

test("the last shared subscriber restores the native transport without removing its provider", () => {
  const run = fixture();
  run.install();
  run.install();
  run.emit("session_start");
  run.emit("session_shutdown");
  expect(run.current()?.auth).toBe(run.original.auth);
  expect(run.current()?.streamSimple).toBe(run.original.streamSimple);
  expect(run.unregisterProvider).not.toHaveBeenCalled();
});

test("shutdown does not replace a later native transport that is not our wrapper", () => {
  const run = fixture();
  run.install();
  run.emit("session_start");
  const replacement: Provider = {
    ...run.original,
    streamSimple: () => createAssistantMessageEventStream(),
  };
  run.registerProvider(replacement);
  run.emit("session_shutdown");
  expect(run.current()).toBe(replacement);
  expect(run.unregisterProvider).not.toHaveBeenCalled();
});

test("a provider request that arrives after its session shut down leaves the transport alone", () => {
  // Pi can still run an in-flight request's payload hook after it disposed the session.
  const run = fixture();
  run.install();
  run.emit("session_start");
  run.emit("session_shutdown");
  run.dispose();
  expect(() => run.emit("before_provider_request")).not.toThrow();
  expect(run.current()?.streamSimple).toBe(run.original.streamSimple);
});
