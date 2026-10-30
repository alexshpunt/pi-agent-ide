import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  IDE_CAPABILITIES_REGISTER,
  IDE_CAPABILITIES_READY,
  IDE_CAPABILITIES_VERSION,
  type IdeCapability,
  type IdeCapabilityRegistration,
  type IdeCapabilitySchema,
} from "#src/api/capabilities.js";
import { composeCapabilitySchema } from "./capability-schemas.js";

const ENTRY = "ide-capabilities/v1";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(value: unknown): asserts value is IdeCapability {
  if (!record(value) || typeof value.id !== "string") throw new Error("Invalid IDE capability");
  if (value.version !== IDE_CAPABILITIES_VERSION || !/^[a-z][a-z0-9._-]*$/u.test(value.id))
    throw new Error("Invalid IDE capability identity");
  if (
    !Array.isArray(value.tools) ||
    value.tools.some((name: unknown) => typeof name !== "string" || !name)
  )
    throw new Error("Invalid IDE capability tools");
  if (value.tools.length === 0 && value.discovery === undefined)
    throw new Error("A capability needs an existing tool or a discovery loader");
  if (value.discovery !== undefined) {
    const discovery = value.discovery;
    if (
      !record(discovery) ||
      typeof discovery.name !== "string" ||
      !/^ide_capability_[a-z0-9_]+$/u.test(discovery.name) ||
      typeof discovery.description !== "string" ||
      !discovery.description.trim()
    )
      throw new Error("Invalid capability discovery metadata");
    if (
      discovery.namespace !== undefined &&
      (!record(discovery.namespace) ||
        typeof discovery.namespace.name !== "string" ||
        typeof discovery.namespace.description !== "string")
    )
      throw new Error("Invalid capability namespace");
  }
  if (!record(value.schemas)) throw new Error("Invalid capability schemas");
  for (const schema of Object.values(value.schemas)) {
    if (
      !record(schema) ||
      (schema.description !== undefined && typeof schema.description !== "string") ||
      (schema.parameters !== undefined &&
        (!record(schema.parameters) ||
          Object.values(schema.parameters).some((text) => typeof text !== "string"))) ||
      (schema.promptGuidelines !== undefined &&
        (!Array.isArray(schema.promptGuidelines) ||
          schema.promptGuidelines.some((text) => typeof text !== "string")))
    )
      throw new Error("Invalid capability schema metadata");
  }
}

/** Own additive metadata and republication while all tool execution stays with its original owner. */
export function createIdeCapabilities(pi: ExtensionAPI) {
  const capabilities = new Map<string, IdeCapability>();
  const publishers = new Map<
    string,
    (contributions: readonly IdeCapabilitySchema[]) => () => void
  >();
  const installedLoaders = new Set<string>();
  let active = new Set<string>();
  let runtimeReady = false;
  const visibleTools = () =>
    new Set(
      pi
        .getAllTools()
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => tool.name),
    );
  const triggers = (capability: IdeCapability) => [
    ...capability.tools,
    ...(capability.discovery ? [capability.discovery.name] : []),
  ];
  const available = (capability: IdeCapability, visible: Set<string>) =>
    triggers(capability).some((name) => visible.has(name));
  const refresh = () => {
    if (!runtimeReady) return;
    const visible = visibleTools();
    const publications = [...publishers].map(([name, prepare]) => {
      const contributions = [...capabilities.values()]
        .filter((capability) => active.has(capability.id) && available(capability, visible))
        .flatMap((capability) =>
          capability.schemas[name] === undefined ? [] : [capability.schemas[name]],
        );
      return prepare(contributions);
    });
    for (const publish of publications) publish();
  };
  const registerTool: ExtensionAPI["registerTool"] = (base) => {
    let previous: string | undefined;
    const prepare = (contributions: readonly IdeCapabilitySchema[]) => {
      const definition = composeCapabilitySchema(base, contributions);
      const signature = JSON.stringify([
        definition.description,
        definition.parameters,
        definition.promptGuidelines,
      ]);
      return () => {
        if (signature === previous) return;
        pi.registerTool(definition);
        previous = signature;
      };
    };
    for (const capability of capabilities.values()) {
      const schema = capability.schemas[base.name];
      if (schema !== undefined) prepare([schema]);
    }
    publishers.set(base.name, prepare);
    // Preserve live getters for plugins that finish registering later in the same startup.
    pi.registerTool(base);
    refresh();
  };
  const activate = (names: readonly string[]) => {
    const visible = visibleTools();
    let changed = false;
    for (const capability of capabilities.values()) {
      if (
        !active.has(capability.id) &&
        available(capability, visible) &&
        triggers(capability).some((name) => names.includes(name) && visible.has(name))
      ) {
        active.add(capability.id);
        changed = true;
      }
    }
    if (changed) {
      pi.appendEntry(ENTRY, { version: 1, active: [...active] });
      refresh();
    }
  };
  const installLoader = (capability: IdeCapability) => {
    const discovery = capability.discovery;
    if (discovery === undefined || installedLoaders.has(discovery.name)) return;
    if (pi.getAllTools().some((tool) => tool.name === discovery.name))
      throw new Error(`Capability loader name is already registered: ${discovery.name}`);
    pi.registerTool({
      name: discovery.name,
      label: discovery.name,
      description: discovery.description,
      exposure: "deferred",
      namespace: discovery.namespace,
      parameters: Type.Object({}),
      renderResult(result) {
        return new Text(
          result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
          0,
          0,
        );
      },
      async execute() {
        activate([discovery.name]);
        return {
          content: [{ type: "text", text: `Enabled capability ${capability.id}.` }],
          details: { capability: capability.id },
        };
      },
    });
    installedLoaders.add(discovery.name);
  };
  const restore = (context: ExtensionContext) => {
    active = new Set();
    for (const entry of context.sessionManager.getBranch()) {
      if (
        entry.type !== "custom" ||
        entry.customType !== ENTRY ||
        !record(entry.data) ||
        entry.data.version !== 1 ||
        !Array.isArray(entry.data.active)
      )
        continue;
      active = new Set(entry.data.active.filter((id): id is string => typeof id === "string"));
    }
    refresh();
  };
  const unsubscribe = pi.events.on(IDE_CAPABILITIES_REGISTER, (value) => {
    const request = value as IdeCapabilityRegistration;
    try {
      const capability = request.capability;
      validate(capability);
      if (capabilities.has(capability.id))
        throw new Error(`Duplicate capability: ${capability.id}`);
      const loader = capability.discovery?.name;
      if (
        loader !== undefined &&
        (publishers.has(loader) ||
          [...capabilities.values()].some((other) => other.discovery?.name === loader) ||
          (runtimeReady && pi.getAllTools().some((tool) => tool.name === loader)))
      )
        throw new Error(`Capability loader name is already registered: ${loader}`);
      for (const [name, schema] of Object.entries(capability.schemas))
        publishers.get(name)?.([schema]);
      const snapshot = structuredClone(capability);
      if (runtimeReady) installLoader(snapshot);
      capabilities.set(snapshot.id, snapshot);
      refresh();
      request.accept();
    } catch (error) {
      request.accept(error instanceof Error ? error : new Error(String(error)));
    }
  });
  pi.on("session_shutdown", unsubscribe);
  pi.on("tool_call", (event) => activate([event.toolName]));
  pi.on("tool_result", (event) => {
    // A tool can register its capability inside execute(), after its first tool_call hook.
    activate([event.toolName]);
    if (
      event.toolName !== "tool_search" ||
      event.isError ||
      !record(event.details) ||
      !Array.isArray(event.details.loaded)
    )
      return;
    activate(event.details.loaded.filter((name): name is string => typeof name === "string"));
  });
  pi.events.emit(IDE_CAPABILITIES_READY, { version: IDE_CAPABILITIES_VERSION });
  return {
    api: { ...pi, registerTool },
    finalize(afterLoaders: () => void) {
      pi.on("session_start", (_event, context) => {
        runtimeReady = true;
        const failures: string[] = [];
        for (const capability of capabilities.values()) {
          try {
            installLoader(capability);
          } catch (error) {
            capabilities.delete(capability.id);
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
        afterLoaders();
        restore(context);
        if (failures.length > 0) throw new Error(failures.join("\n"));
      });
      pi.on("session_tree", (_event, context) => restore(context));
      pi.on("session_compact", (_event, context) => restore(context));
      pi.on("before_agent_start", refresh);
      pi.on("turn_start", refresh);
    },
  };
}
