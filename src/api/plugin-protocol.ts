import type { IdeTool } from "#src/toolchain/types.js";

export const IDE_PROTOCOL = "pi-agent-ide" as const;

export const IDE_API_VERSION = 1 as const;

export const IDE_CORE_READY_EVENT = "pi-agent-ide/core/ready" as const;

export const IDE_PLUGIN_REGISTER_EVENT = "pi-agent-ide/plugin/register" as const;

export interface IdeCoreReady {
  readonly protocol: typeof IDE_PROTOCOL;
  readonly apiVersion: typeof IDE_API_VERSION;
}

export interface IdePluginApi {
  addTool(tool: IdeTool): void;
}

export interface IdePlugin {
  readonly protocol: typeof IDE_PROTOCOL;
  readonly apiVersion: typeof IDE_API_VERSION;
  readonly id: string;
  readonly setup: (api: IdePluginApi) => void | Promise<void>;
}

export interface IdePluginRegistrationRequest {
  readonly plugin: IdePlugin;
  accept(registration: Promise<void>): void;
}

export function isIdeCoreReady(value: unknown): value is IdeCoreReady {
  return isRecord(value) && value.protocol === IDE_PROTOCOL && value.apiVersion === IDE_API_VERSION;
}

export function isIdePlugin(value: unknown): value is IdePlugin {
  return (
    isRecord(value) &&
    value.protocol === IDE_PROTOCOL &&
    value.apiVersion === IDE_API_VERSION &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.setup === "function"
  );
}

export function isIdePluginRegistrationRequest(
  value: unknown,
): value is IdePluginRegistrationRequest {
  return isRecord(value) && isIdePlugin(value.plugin) && typeof value.accept === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
