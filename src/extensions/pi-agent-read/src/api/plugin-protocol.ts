import { Type } from "typebox";
import { Value } from "typebox/value";

import type { ReadToolPluginApi } from "#src/api/tools/read.js";

export const READ_PROTOCOL = "pi-agent-read";

export const READ_API_VERSION = 9;

export const READ_CORE_READY_EVENT = `${READ_PROTOCOL}/core/ready`;

export const READ_PLUGIN_REGISTER_EVENT = `${READ_PROTOCOL}/plugin/register`;

export interface ReadCoreReady {
  readonly protocol: typeof READ_PROTOCOL;
  readonly apiVersion: typeof READ_API_VERSION;
}

export type ReadPluginApi = ReadToolPluginApi;

export interface ReadPlugin {
  readonly protocol: typeof READ_PROTOCOL;
  readonly apiVersion: typeof READ_API_VERSION;
  readonly id: string;
  readonly setup: (api: ReadPluginApi) => void | Promise<void>;
}

export interface ReadPluginRegistrationRequest {
  readonly plugin: ReadPlugin;
  accept(registration: Promise<void>): void;
}

const functionSchema = Type.Function([], Type.Unknown());
const readCoreReadySchema = Type.Object({
  protocol: Type.Literal(READ_PROTOCOL),
  apiVersion: Type.Literal(READ_API_VERSION),
});
const readPluginSchema = Type.Object({
  protocol: Type.Literal(READ_PROTOCOL),
  apiVersion: Type.Literal(READ_API_VERSION),
  id: Type.String(),
  setup: functionSchema,
});
const readPluginRegistrationRequestSchema = Type.Object({
  plugin: readPluginSchema,
  accept: functionSchema,
});

export function isReadCoreReady(value: unknown): value is ReadCoreReady {
  return Value.Check(readCoreReadySchema, value);
}

export function isReadPlugin(value: unknown): value is ReadPlugin {
  return Value.Check(readPluginSchema, value);
}

export function isReadPluginRegistrationRequest(
  value: unknown,
): value is ReadPluginRegistrationRequest {
  return Value.Check(readPluginRegistrationRequestSchema, value);
}
