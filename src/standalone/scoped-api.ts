import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolCallHeader } from "pi-agent-tool-ui";
import { connectResultTargets } from "pi-agent-resource";
import type { ReadPluginApi } from "pi-agent-read/api/plugin-protocol";
import { getLastResolvedResource } from "#src/extensions/pi-agent-text-editor/src/api/last-resolved-resource.js";
import type { StandaloneResourceHostOptions, StandaloneResourceTool } from "./resource-host.js";

const verbs: readonly StandaloneResourceTool[] = [
  "read",
  "search",
  "select",
  "write",
  "replace",
  "insert",
  "delete",
  "copy",
  "move",
  "diff",
];
const fields: Record<string, readonly string[]> = {
  read: ["path"],
  search: ["path"],
  select: ["path"],
  write: ["path"],
  replace: ["path"],
  insert: ["path"],
  delete: ["path"],
  copy: ["path", "target"],
  move: ["path", "target"],
  diff: ["before", "after"],
};
const readonly = new Set(["read", "search", "select", "diff"]);
const reservationChannel = "pi-agent-ide/standalone-reservation/v1";
type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;
type Subscribe = (event: string, handler: Handler) => () => void;
type ToolContext = Parameters<ToolDefinition["execute"]>[4];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const shared = (channel: string) =>
  channel.startsWith("pi-agent-ide/operation-approval/") ||
  channel.startsWith("pi-agent-ide/settings/");

/** A protocol island and name adapter. It exposes provider resources, never general IDE tools. */
export function createResourceHostApi(pi: ExtensionAPI, options: StandaloneResourceHostOptions) {
  const prefix = options.namespace.name;
  if (!/^[a-z][a-z0-9_]*$/u.test(prefix))
    throw new Error("Resource host namespace must be a lowercase identifier.");
  const selected = new Set(options.tools ?? verbs);
  if ([...selected].some((name) => !verbs.includes(name)))
    throw new Error("Unsupported resource host tool.");
  const claim = { namespace: prefix, claimed: false };
  pi.events.emit(reservationChannel, claim);
  if (claim.claimed) throw new Error(`Resource host namespace already registered: ${prefix}`);
  const releaseNamespace = pi.events.on(reservationChannel, (request) => {
    if (record(request) && request.namespace === prefix) request.claimed = true;
  });
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const shutdown = new Set<Handler>();
  const unsubscribes: (() => void)[] = [releaseNamespace];
  const active = new Map<AbortController, Promise<void>>();
  const definitions = new Map<string, () => void>();
  const parents = new Set<string>();
  let closed = false;
  let read: ReadPluginApi | undefined;
  let api: ExtensionAPI;
  const publicName = (name: string) => `${prefix}_${name}`;
  const localName = (name: unknown) =>
    typeof name === "string" &&
    name.startsWith(prefix + "_") &&
    selected.has(name.slice(prefix.length + 1) as StandaloneResourceTool)
      ? name.slice(prefix.length + 1)
      : undefined;
  const words = (value: string) =>
    value.replace(
      /\b(?:read|search|select|write|replace|insert|delete|copy|move|diff)\b/gu,
      (name, offset: number) => {
        const before = value.slice(0, offset);
        const after = value.slice(offset + name.length);
        // Adapt tool references, not prose verbs, guide IDs or resource addresses.
        const reference =
          before.endsWith("tools.") ||
          (before.endsWith("`") && /^[`.]/u.test(after)) ||
          (/(?:\bUse|\band) $/u.test(before) && after.startsWith(" to "));
        return reference ? publicName(name) : name;
      },
    );
  function owns(source: string, mutation: boolean): boolean {
    const value = source.startsWith("raw:") && !mutation ? source.slice(4) : source;
    if (!mutation && (value.startsWith("docs:") || value.startsWith("temp:"))) return true;
    return (
      /^[a-z][a-z\d+.-]*:\/\//iu.test(value) &&
      !/^(?:file:|[a-z]:[/\\])/iu.test(value) &&
      options.ownsSource(value)
    );
  }
  const targets = () => connectResultTargets(api);
  async function checkSource(
    value: unknown,
    context: ExtensionContext,
    mutation: boolean,
  ): Promise<void> {
    const source = targets().source(value, context.cwd, !mutation);
    if (Array.isArray(source)) {
      for (const item of source) await checkSource(item, context, mutation);
      return;
    }
    if (record(source) && "path" in source) {
      await checkSource(source.path, context, mutation);
      return;
    }
    if (typeof source !== "string")
      throw new Error("Use an owned resource URI or an issued source result.");
    if (source.startsWith("RESULT#")) {
      const resolved = targets().resolve(source, context.cwd);
      if (resolved.targets.some((target) => !owns(target.source, mutation)))
        throw new Error("Source selection belongs outside this resource host.");
      await targets().verify(resolved, context.signal);
      return;
    }
    if (source.startsWith("SEARCH#")) {
      const resolved = await read?.read(
        { path: source },
        { cwd: context.cwd, signal: context.signal },
        "script",
      );
      if (resolved?.isError || resolved?.script?.kind !== "text" || !resolved.script.target)
        throw new Error("Unknown or expired resource search selection.");
      await checkSource(resolved.script.target, context, mutation);
      return;
    }
    if (!owns(source, mutation))
      throw new Error(
        "Use this host only for its provider-owned resource URIs; local paths are not supported.",
      );
  }
  async function validate(name: string, value: unknown, context: ExtensionContext): Promise<void> {
    if (closed) throw new Error("Standalone resource host is closed.");
    if (!record(value)) throw new Error("Resource tool arguments must be an object.");
    const mutation = !readonly.has(name);
    const sources = fields[name] ?? [];
    if (["read", "search", "select"].includes(name) && value.path === undefined)
      throw new Error("Supply an explicit owned resource or source result.");
    if (mutation && value.path === undefined) {
      const inherited = getLastResolvedResource(api)?.source;
      if (!inherited) throw new Error("Supply an owned source before editing.");
      await checkSource(inherited, context, true);
    }
    for (const field of sources)
      if (value[field] !== undefined) await checkSource(value[field], context, mutation);
    for (const field of ["start", "end", "anchor", "targetStart", "targetEnd"]) {
      const anchor = value[field];
      if (typeof anchor === "string" && /^(?:RESULT#|SEARCH#|<system-result)/u.test(anchor))
        await checkSource(anchor, context, mutation);
    }
    if (name === "select" && record(value.operation) && "scopes" in value.operation)
      await checkSource(value.operation.scopes, context, false);
    if (name === "write" && typeof value.content !== "string")
      throw new Error(
        "Standalone resource Write accepts text/JSON content, not filesystem image writes.",
      );
  }
  // Pi's overloads describe fixed event/result pairs; this private adapter forwards each pair unchanged.
  const subscribe: Subscribe = (event, handler) =>
    pi.on(
      event as "tool_call",
      async (value, context) =>
        (await handler({ ...value }, context)) as ToolCallEventResult | undefined,
    );
  // Run before provider hooks: local fallbacks and foreign references never reach an executor.
  unsubscribes.push(
    subscribe("tool_call", async (event, context) => {
      const name = localName(event.toolName);
      if (!name) return;
      try {
        await validate(name, event.input, context);
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  const on: ExtensionAPI["on"] = (event: string, original: unknown) => {
    const handler = original as Handler;
    if (event === "session_shutdown") {
      shutdown.add(handler);
      return () => {
        shutdown.delete(handler);
      };
    }
    const off = subscribe(event, async (raw, context) => {
      if (closed) return;
      let input = raw;
      if (event.startsWith("tool_")) {
        const name = localName(raw.toolName);
        if (name) {
          if (typeof raw.parentToolCallId === "string") parents.add(raw.parentToolCallId);
          input = { ...raw, toolName: name };
        } else if (typeof raw.toolCallId === "string" && parents.has(raw.toolCallId)) {
          input = {
            ...raw,
            toolName: raw.toolName === "codemode" ? "codemode" : "__standalone_parent",
          };
        } else return;
      }
      if (event === "message_end") {
        if (!record(raw.message) || raw.message.role !== "toolResult") return;
        const name = localName(raw.message.toolName);
        if (!name) return;
        input = { ...raw, message: { ...raw.message, toolName: name } };
      }
      if (event === "context" && Array.isArray(raw.messages)) {
        input = {
          ...raw,
          messages: raw.messages.map((message: unknown) =>
            record(message) && typeof message.toolName === "string"
              ? { ...message, toolName: localName(message.toolName) ?? "__outside_resource_host" }
              : message,
          ),
        };
      }
      const result = await handler(input, context);
      if (!record(result)) return result;
      if (event === "message_end" && record(result.message) && record(raw.message))
        return { ...result, message: { ...result.message, toolName: raw.message.toolName } };
      if (event === "context" && Array.isArray(result.messages) && Array.isArray(raw.messages)) {
        const originals = raw.messages;
        if (result.messages.length !== originals.length)
          throw new Error("Resource host context handlers must preserve message positions.");
        return {
          ...result,
          messages: result.messages.map((message: unknown, index: number) => {
            const original = originals[index] as unknown;
            return record(message) && record(original) && typeof original.toolName === "string"
              ? { ...message, toolName: original.toolName }
              : message;
          }),
        };
      }
      return result;
    });
    unsubscribes.push(off);
    return off;
  };
  const events: ExtensionAPI["events"] = {
    emit(channel, data) {
      if (closed) throw new Error("Standalone resource host is closed.");
      if (shared(channel)) pi.events.emit(channel, data);
      else for (const handler of listeners.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      if (shared(channel)) {
        const off = pi.events.on(channel, handler);
        unsubscribes.push(off);
        return off;
      }
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
  };
  function descriptions(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(descriptions);
    if (!record(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "description" && typeof item === "string" ? words(item) : descriptions(item),
      ]),
    );
  }
  function toolContext(context: ToolContext): ToolContext {
    return {
      ...context,
      tools: context.tools.flatMap((tool) => {
        const name = localName(tool.name);
        return name ? [{ ...tool, name }] : [];
      }),
      executeTool(name, args, execution) {
        if (!selected.has(name as StandaloneResourceTool))
          throw new Error("Tool is not owned by this resource host.");
        return context.executeTool(publicName(name), args, execution);
      },
    };
  }
  const registerTool: ExtensionAPI["registerTool"] = (definition) => {
    const name = definition.name;
    if (!selected.has(name as StandaloneResourceTool)) return;
    const descriptors = Object.getOwnPropertyDescriptors(definition);
    descriptors.name = { value: publicName(name), enumerable: true, configurable: true };
    descriptors.label = { value: publicName(name), enumerable: true, configurable: true };
    descriptors.namespace = { value: options.namespace, enumerable: true, configurable: true };
    descriptors.exposure = { value: "deferred", enumerable: true, configurable: true };
    descriptors.description = {
      get: () =>
        `Use ${publicName(name)} to ${name === "read" ? "inspect provider-owned resources and packaged guides" : name === "search" ? "find objects or text within an explicit provider-owned resource" : name === "select" ? "derive guarded text selections from owned resources" : `${name} provider-owned text resources`}.`,
      enumerable: true,
      configurable: true,
    };
    descriptors.promptSnippet = {
      get: () => words(definition.promptSnippet ?? ""),
      enumerable: true,
      configurable: true,
    };
    descriptors.promptGuidelines = {
      get: () => [
        ...(definition.promptGuidelines ?? []).map(words),
        "Use only this namespace's owned resource URIs and issued results. Local filesystem paths are not supported.",
      ],
      enumerable: true,
      configurable: true,
    };
    descriptors.parameters = {
      get: () => {
        const schema = descriptions(definition.parameters) as Record<string, unknown>;
        const properties = record(schema.properties) ? { ...schema.properties } : {};
        for (const field of fields[name] ?? [])
          if (record(properties[field]))
            properties[field] = {
              ...properties[field],
              description:
                "Provider-owned resource URI, unchanged source result, or an issued reference.",
            };
        if (name === "write")
          properties.content = Type.String({
            description:
              "Complete text/Markdown or JSON payload for the selected provider resource.",
          });
        return Object.assign({}, definition.parameters, schema, { properties });
      },
      enumerable: true,
      configurable: true,
    };
    const execute: typeof definition.execute = async (id, args, signal, update, context) => {
      if (closed) throw new Error("Standalone resource host is closed.");
      const controller = new AbortController();
      let finish: () => void = () => {};
      const completion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      active.set(controller, completion);
      const signals = [signal, context.signal, controller.signal].filter(
        (value): value is AbortSignal => value !== undefined,
      );
      const combined = AbortSignal.any(signals);
      try {
        const scoped = { ...toolContext(context), signal: combined };
        await validate(name, args, scoped);
        combined.throwIfAborted();
        return await definition.execute(id, args, combined, update, scoped);
      } finally {
        active.delete(controller);
        finish();
      }
    };
    descriptors.execute = { value: execute, enumerable: true, configurable: true };
    const renderCall: NonNullable<typeof definition.renderCall> = (args, theme, context) => {
      // Mutation renderers keep their preview/diff state in renderCall, shared with renderResult.
      if (!readonly.has(name) && definition.renderCall)
        return definition.renderCall(args, theme, context);
      return toolCallHeader(
        context.lastComponent,
        {
          tool: publicName(name),
          primary: {
            text: record(args)
              ? String(args.path ?? args.query ?? "owned resource")
              : "owned resource",
            truncate: "end",
          },
          expanded: context.expanded,
        },
        theme,
      );
    };
    descriptors.renderCall = { value: renderCall, enumerable: true, configurable: true };
    const exposed = Object.defineProperties({}, descriptors) as typeof definition;
    definitions.set(name, () => pi.registerTool({ ...exposed, exposure: "hidden" }));
    pi.registerTool(exposed);
  };
  api = {
    ...pi,
    events,
    on,
    registerTool,
    getActiveTools: () =>
      pi.getActiveTools().flatMap((name) => {
        const local = localName(name);
        return local ? [local] : [];
      }),
    getAllTools: () =>
      pi.getAllTools().flatMap((tool) => {
        const name = localName(tool.name);
        return name ? [{ ...tool, name }] : [];
      }),
    setActiveTools(names) {
      const active = pi.getActiveTools().filter((name) => !localName(name));
      pi.setActiveTools([
        ...active,
        ...names.filter((name) => selected.has(name as StandaloneResourceTool)).map(publicName),
      ]);
    },
  };
  unsubscribes.push(
    subscribe("session_start", () => {
      parents.clear();
      if (
        !(pi.getSettings().defaultTools ?? []).includes("-tool_search") &&
        pi
          .getAllTools()
          .some((tool) => tool.name === "tool_search" && tool.exposure !== "hidden") &&
        !pi.getActiveTools().includes("tool_search")
      )
        pi.setActiveTools([...pi.getActiveTools(), "tool_search"]);
    }),
  );
  unsubscribes.push(
    subscribe("agent_end", () => {
      parents.clear();
    }),
  );
  async function dispose(context?: ExtensionContext, hideTools = true): Promise<void> {
    if (closed) return;
    closed = true;
    for (const controller of active.keys()) controller.abort();
    await Promise.all(active.values());
    const outcomes = await Promise.allSettled(
      [...shutdown].map((handler) =>
        handler({ type: "session_shutdown" }, context as ExtensionContext),
      ),
    );
    for (const off of unsubscribes) off();
    listeners.clear();
    shutdown.clear();
    parents.clear();
    if (hideTools) for (const hide of definitions.values()) hide();
    definitions.clear();
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  unsubscribes.push(subscribe("session_shutdown", (_event, context) => dispose(context, false)));
  return {
    api,
    owns,
    tools: [...selected].map(publicName),
    dispose,
    setApi(value: ExtensionAPI) {
      api = value;
    },
    setRead(value: ReadPluginApi) {
      read = value;
    },
  };
}
