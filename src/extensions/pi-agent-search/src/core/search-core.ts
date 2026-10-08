import { withBlockedToolResult } from "pi-agent-tool-call-interception";
import {
  resourceAccesses,
  resourceScheduler,
  withStructuredResult,
  type ResultTargetStore,
} from "pi-agent-resource";
import { searchDataSchema } from "#src/api/structured-result.js";

import type { SearchPlugin } from "#src/api/plugin-protocol.js";
import type {
  SearchActionRegistration,
  SearchEnvironmentProvider,
  SearchSelectionProvider,
  SearchContext,
  SearchDescriptionSource,
  SearchPluginApi,
  SearchRequest,
  SearchInput,
  SearchResolutionAttempt,
  SearchResolverRegistration,
  SearchToolDetails,
  SearchToolResult,
} from "#src/api/search.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

interface RegisteredResolver {
  readonly pluginId: string;
  readonly registration: SearchResolverRegistration;
  readonly order: number;
}

export interface SearchCore {
  registerPlugin(plugin: SearchPlugin): Promise<void>;
  waitForPendingPlugins(): Promise<void>;
  execute(
    request: SearchInput,
    context: SearchContext,
    audience?: "agent" | "script",
  ): Promise<SearchToolResult>;
  runAction(
    reference: string,
    capability: string,
    resolverId: string,
    input: unknown,
    context: SearchContext,
  ): Promise<unknown>;
  renderPromptGuidelines(): readonly string[];
  /** Describes capabilities contributed by successfully registered plugins. */
  renderDescriptions(): readonly string[];
  renderer(resolverId: string): SearchResolverRegistration["resolver"]["renderResult"];
}

export function createSearchCore(targets?: ResultTargetStore): SearchCore {
  const resolvers: RegisteredResolver[] = [];
  const environments: SearchEnvironmentProvider[] = [];
  let selectionProvider: SearchSelectionProvider | undefined;
  const actions = new Map<string, SearchActionRegistration>();
  const promptGuidelines = new Map<string, SearchDescriptionSource[]>();
  const descriptions = new Map<string, SearchDescriptionSource>();
  const plugins = new Map<string, Promise<void>>();
  let queue = Promise.resolve();

  const core: SearchCore = {
    registerPlugin(plugin): Promise<void> {
      if (plugin.id.trim().length === 0) {
        return Promise.reject(new Error("Plugin ID must not be empty"));
      }

      const existing = plugins.get(plugin.id);

      if (existing !== undefined) {
        return existing;
      }

      const ready = queue.then(async () => {
        const draftResolvers: SearchResolverRegistration[] = [];
        const draftEnvironments: SearchEnvironmentProvider[] = [];
        const draftActions: SearchActionRegistration[] = [];
        let draftSelectionProvider: SearchSelectionProvider | undefined;
        let draftDescription: SearchDescriptionSource | undefined;
        const draftPromptGuidelines: SearchDescriptionSource[] = [];
        const api: SearchPluginApi = {
          addEnvironmentProvider(provider) {
            draftEnvironments.push(provider);
          },
          addSelectionProvider(provider) {
            if (draftSelectionProvider !== undefined || selectionProvider !== undefined)
              throw new Error("Search selection provider is already registered");
            draftSelectionProvider = provider;
          },
          registerSelection(selection, context) {
            if (selectionProvider === undefined)
              throw new Error(
                "Search selections are unavailable. Enable the shared search selection plugin.",
              );
            return selectionProvider(selection, context);
          },
          addResolver(registration): void {
            assertResolver(registration);
            draftResolvers.push(registration);
          },
          addAction(registration): void {
            assertAction(registration);
            draftActions.push(registration);
          },
          describe(description): void {
            if (draftDescription !== undefined) {
              throw new Error(`Plugin ${plugin.id} provides more than one description`);
            }

            draftDescription = normalizeDescriptionSource(description);
          },
          addPromptGuideline(guideline): void {
            draftPromptGuidelines.push(normalizeDescriptionSource(guideline));
          },
          search: (request, context, audience) => core.execute(request, context, audience),
          runAction(request, context): Promise<unknown> {
            return core.runAction(
              request.reference,
              request.capability,
              request.resolverId,
              request.input,
              context,
            );
          },
        };
        await plugin.setup(api);
        const ids = new Set(resolvers.map(({ registration }) => registration.resolver.id));

        for (const registration of draftResolvers) {
          if (ids.has(registration.resolver.id)) {
            throw new Error(`Search resolver ${registration.resolver.id} is already registered`);
          }

          ids.add(registration.resolver.id);
        }

        for (const action of draftActions) {
          const key = actionKey(action.resolverId, action.capability);

          if (
            actions.has(key) ||
            draftActions.some(
              (candidate) =>
                candidate !== action &&
                actionKey(candidate.resolverId, candidate.capability) === key,
            )
          ) {
            throw new Error(`Search action ${key} is already registered`);
          }
        }

        for (const registration of draftResolvers) {
          resolvers.push({ pluginId: plugin.id, registration, order: resolvers.length });
        }
        if (draftSelectionProvider !== undefined) selectionProvider = draftSelectionProvider;
        environments.push(...draftEnvironments);

        for (const action of draftActions) {
          actions.set(actionKey(action.resolverId, action.capability), action);
        }

        if (draftDescription !== undefined) descriptions.set(plugin.id, draftDescription);
        if (draftPromptGuidelines.length > 0) {
          promptGuidelines.set(plugin.id, draftPromptGuidelines);
        }
        return;
      });
      plugins.set(plugin.id, ready);
      queue = ready.catch(() => {});
      void ready.catch(() => {
        plugins.delete(plugin.id);
        return;
      });
      return ready;
    },
    async waitForPendingPlugins(): Promise<void> {
      await Promise.all(plugins.values());
    },
    async execute(input, context, audience = "agent"): Promise<SearchToolResult> {
      let request: SearchRequest = {
        ...input,
        path: typeof input.path === "string" ? input.path : undefined,
      };
      if (request.query.trim().length === 0) {
        return failure("INVALID_REQUEST", "Search query must not be empty");
      }

      if (input.navigation !== undefined && !input.query.startsWith("symbols:"))
        return failure(
          "INVALID_REQUEST",
          "Reference navigation is supported only for symbols: queries.",
        );
      try {
        const scoped =
          input.path !== undefined &&
          (typeof input.path !== "string" || input.path.startsWith("RESULT#"));
        if (scoped) {
          if (targets === undefined) throw new Error("Result scopes are unavailable.");
          if (context.scope !== undefined) throw new Error("Pass one result scope, not two.");
          const scope = targets.resolve(input.path, context.cwd);
          await targets.verify(scope, context.signal);
          context = { ...context, scope };
          request = { ...request, path: undefined };
        }
        if (context.scope !== undefined) {
          const ownerContext = context;
          context = {
            ...context,
            environmentForSource: (source) => {
              for (const provider of environments) {
                const owner = provider({ ...request, path: source }, ownerContext);
                if (owner !== undefined) return owner;
              }
              return undefined;
            },
          };
        }
        for (const provider of context.scope === undefined ? environments : []) {
          const environment = provider(request, context);
          if (environment !== undefined) {
            context = { ...context, environment };
            break;
          }
        }
      } catch (error) {
        return failure(
          "RESOLVE_FAILED",
          messageFor(error, "Search scope is unavailable"),
          undefined,
          error,
        );
      }
      const snapshot = [...resolvers].sort(
        (left, right) =>
          Number(left.registration.fallback === true) -
            Number(right.registration.fallback === true) ||
          (left.registration.priority ?? 0) - (right.registration.priority ?? 0) ||
          left.order - right.order,
      );

      const emptyProtocol = /^[a-z][\w-]*:\s*$/iu.test(request.query);
      const protocolLike = /^[a-z][\w-]*:/iu.test(request.query);
      for (const entry of snapshot) {
        if (context.scope !== undefined && entry.registration.resolver.supportsResultScope !== true)
          continue;
        const structuralProtocol = /^(?:ast|symbols):/u.test(request.query);
        if (entry.registration.fallback && structuralProtocol && context.scope !== undefined)
          continue;
        if (emptyProtocol && !entry.registration.fallback && context.scope === undefined) continue;
        const resolver = entry.registration.resolver;
        if (context.scope !== undefined && resolver.supportsResultScope !== true) continue;
        if (context.scope !== undefined && entry.registration.fallback && protocolLike) continue;

        try {
          const scope = Promise.resolve().then(async () => {
            const sources = await resolver.readResources?.(request, context);
            if (sources === undefined) return [{ resource: "*", mode: "read" as const }];
            return (
              await Promise.all(
                sources.map((source) => resourceAccesses(source, context.cwd, "read")),
              )
            ).flat();
          });
          const result = await resourceScheduler.run(
            scope,
            async (): Promise<SearchToolResult | undefined> => {
              let attempt: unknown;

              try {
                context.signal?.throwIfAborted();
                attempt = await resolver.tryResolve(request, context);
              } catch (error) {
                return failure(
                  "RESOLVE_FAILED",
                  messageFor(error, `Resolver ${resolver.id} failed`),
                  resolver.id,
                  error,
                );
              }

              if (!isAttempt(attempt)) {
                return failure(
                  "INVALID_RESOLVER_RESULT",
                  `Resolver ${resolver.id} returned an invalid result`,
                  resolver.id,
                );
              }

              if (attempt.kind === "not-handled") {
                return undefined;
              }

              if (attempt.kind === "failed") {
                return failure(
                  "RESOLVE_FAILED",
                  messageFor(attempt.error, `Resolver ${resolver.id} failed`),
                  resolver.id,
                  attempt.error,
                );
              }

              try {
                const formatted = await resolver.format(attempt.payload, context);

                if (!isAgentToolResult(formatted)) {
                  return failure(
                    "FORMAT_FAILED",
                    `Resolver ${resolver.id} formatter returned an invalid result`,
                    resolver.id,
                  );
                }

                const data = resolver.toScriptData?.(attempt.payload, formatted.details);
                const missingAdapter = data === undefined;
                return withStructuredResult(
                  {
                    content: [
                      ...(entry.registration.fallback && protocolLike
                        ? [
                            {
                              type: "text" as const,
                              text: emptyProtocol
                                ? "Search fallback: empty protocol query; searched the original text."
                                : "Search fallback: unhandled protocol query; searched the original text.",
                            },
                            ...formatted.content,
                          ]
                        : formatted.content),
                      ...(isRecord(data) && data.complete === false
                        ? [
                            {
                              type: "text" as const,
                              text: "Search coverage is incomplete. Do not conclude absence or use this result as an edit scope.",
                            },
                          ]
                        : []),
                    ],
                    details: { resolverId: resolver.id, payload: formatted.details },
                    ...(audience === "script" && {
                      script: {
                        resolverId: resolver.id,
                        data: attempt.payload,
                        details: formatted.details,
                      },
                    }),
                    ...(formatted.usage !== undefined && { usage: formatted.usage }),
                  },
                  searchDataSchema,
                  missingAdapter
                    ? {
                        status: "error",
                        errors: [
                          {
                            code: "STRUCTURED_ADAPTER_REQUIRED",
                            message: `Search resolver ${resolver.id} must provide toScriptData`,
                          },
                        ],
                      }
                    : formatted.isError
                      ? {
                          status: "error",
                          data,
                          errors: [
                            {
                              code: "RESOLVE_FAILED",
                              message: `Search resolver ${resolver.id} returned an error`,
                            },
                          ],
                        }
                      : { status: "success", data, errors: [] },
                );
              } catch (error) {
                return failure(
                  "FORMAT_FAILED",
                  messageFor(error, `Resolver ${resolver.id} formatter failed`),
                  resolver.id,
                  error,
                );
              }
            },
            context.signal,
          );
          if (result !== undefined) return result;
        } catch (error) {
          return failure(
            "RESOLVE_FAILED",
            messageFor(error, `Resolver ${resolver.id} failed`),
            resolver.id,
            error,
          );
        }
      }

      const reason = `No search resolver handled ${request.query}`;
      return withBlockedToolResult(failure("NO_RESOLVER", reason), reason);
    },
    runAction(reference, capability, resolverId, input, context): Promise<unknown> {
      const action = actions.get(actionKey(resolverId, capability));

      if (action === undefined) {
        throw new Error(`Search reference does not support ${capability}`);
      }

      return action.execute(reference, input, context);
    },
    renderDescriptions(): readonly string[] {
      return [...descriptions.values()].flatMap((source) => {
        const description = renderDescription(source);
        return description === undefined ? [] : [description];
      });
    },
    renderPromptGuidelines(): readonly string[] {
      return [...promptGuidelines.values()].flat().flatMap((source) => {
        const guideline = renderDescription(source);
        return guideline === undefined ? [] : [guideline];
      });
    },
    renderer(resolverId) {
      return resolvers.find(({ registration }) => registration.resolver.id === resolverId)
        ?.registration.resolver.renderResult;
    },
  };

  return core;
}

function assertResolver(value: unknown): asserts value is SearchResolverRegistration {
  if (!isRecord(value) || !isRecord(value.resolver)) {
    throw new TypeError("Invalid search resolver registration");
  }

  const resolver = value.resolver;

  if (
    typeof resolver.id !== "string" ||
    resolver.id.trim().length === 0 ||
    typeof resolver.tryResolve !== "function" ||
    typeof resolver.format !== "function"
  ) {
    throw new TypeError("Invalid search resolver registration");
  }

  if (
    value.priority !== undefined &&
    (typeof value.priority !== "number" || !Number.isFinite(value.priority))
  ) {
    throw new TypeError("Invalid search resolver priority");
  }
}

function assertAction(value: unknown): asserts value is SearchActionRegistration {
  if (
    !isRecord(value) ||
    typeof value.resolverId !== "string" ||
    value.resolverId.trim().length === 0 ||
    typeof value.capability !== "string" ||
    value.capability.trim().length === 0 ||
    typeof value.execute !== "function"
  ) {
    throw new TypeError("Invalid search action registration");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAttempt(value: unknown): value is SearchResolutionAttempt {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }

  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "not-handled" ||
    (kind === "resolved" && "payload" in value) ||
    (kind === "failed" && "error" in value)
  );
}

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function failure(
  code: NonNullable<SearchToolDetails["failure"]>["code"],
  message: string,
  resolverId?: string,
  cause?: unknown,
): AgentToolResult<SearchToolDetails> {
  return withStructuredResult(
    {
      isError: true,
      content: [{ type: "text", text: message }],
      details: {
        failure: {
          code,
          message,
          ...(resolverId !== undefined && { resolverId }),
          ...(cause !== undefined && { cause }),
        },
      },
    },
    searchDataSchema,
    { status: "error", errors: [{ code, message }] },
  );
}

function normalizeDescriptionSource(value: unknown): SearchDescriptionSource {
  if (typeof value === "function") {
    return value as () => string | undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Search description must not be empty");
  }

  return value.trim();
}

function renderDescription(source: SearchDescriptionSource): string | undefined {
  const value = typeof source === "function" ? source() : source;

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Search description must not be empty");
  }

  return value.trim();
}

function actionKey(resolverId: string, capability: string): string {
  return `${resolverId}:${capability}`;
}

function messageFor(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return fallback;
  return error instanceof SyntaxError ? error.message : `${fallback}: ${error.message}`;
}
