import { Type } from "typebox";
import { Value } from "typebox/value";

import type { SearchPluginApi } from "#src/api/search.js";

export const SEARCH_PROTOCOL = "pi-agent-search" as const;

export const SEARCH_API_VERSION = 1 as const;

export const SEARCH_CORE_READY_EVENT = "pi-agent-search/core/ready" as const;

export const SEARCH_PLUGIN_REGISTER_EVENT = "pi-agent-search/plugin/register" as const;

export interface SearchCoreReady {
  readonly protocol: typeof SEARCH_PROTOCOL;
  readonly apiVersion: typeof SEARCH_API_VERSION;
}

export interface SearchPlugin {
  readonly protocol: typeof SEARCH_PROTOCOL;
  readonly apiVersion: typeof SEARCH_API_VERSION;
  readonly id: string;
  readonly setup: (api: SearchPluginApi) => void | Promise<void>;
}

export interface SearchPluginRegistrationRequest {
  readonly plugin: SearchPlugin;
  accept(registration: Promise<void>): void;
}

const functionSchema = Type.Unsafe<(...arguments_: never[]) => unknown>({ type: "Function" });
const coreReadySchema = Type.Object({
  protocol: Type.Literal(SEARCH_PROTOCOL),
  apiVersion: Type.Literal(SEARCH_API_VERSION),
});
const pluginSchema = Type.Object({
  protocol: Type.Literal(SEARCH_PROTOCOL),
  apiVersion: Type.Literal(SEARCH_API_VERSION),
  id: Type.String({ minLength: 1 }),
  setup: functionSchema,
});
const registrationSchema = Type.Object({ plugin: pluginSchema, accept: functionSchema });

export function isSearchCoreReady(value: unknown): value is SearchCoreReady {
  return Value.Check(coreReadySchema, value);
}

export function isSearchPlugin(value: unknown): value is SearchPlugin {
  return Value.Check(pluginSchema, value);
}

export function isSearchPluginRegistrationRequest(
  value: unknown,
): value is SearchPluginRegistrationRequest {
  return Value.Check(registrationSchema, value);
}
