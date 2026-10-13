import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Metadata shared by external settings and the built-in Agent IDE settings menu. */
interface SettingBase {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly group?: "features" | "ui";
}

/** Boolean settings use flags storage; choice and text settings use preferences storage. */
export type AgentIdeSetting =
  | (SettingBase & {
      readonly kind: "boolean";
      readonly default: boolean;
      readonly labels?: { readonly on: string; readonly off: string };
    })
  | (SettingBase & {
      readonly kind: "choice";
      readonly default: string;
      readonly values: readonly { readonly value: string; readonly label: string }[];
    })
  | (SettingBase & {
      readonly kind: "text";
      readonly default: string;
      readonly placeholder?: string;
    });

/** A saved override includes explicit false; Default removes the selected scope's key. */
export interface AgentIdeSettingValue {
  readonly value: boolean | string;
  readonly overridden: boolean;
}

export const SETTINGS_REGISTER_EVENT = "pi-agent-ide/settings/register/v1";
export const SETTINGS_READ_EVENT = "pi-agent-ide/settings/read/v1";
export const SETTINGS_READY_EVENT = "pi-agent-ide/settings/ready/v1";

/** Synchronous acceptance keeps extension-registration errors visible to their caller. */
export interface SettingsRegistration {
  readonly owner: string;
  readonly definitions: readonly AgentIdeSetting[];
  accept(error?: Error): void;
}

/** Reads resolve through the host so external packages do not duplicate storage policy. */
export interface SettingsReadRequest {
  readonly id: string;
  readonly cwd: string;
  accept(result: Promise<AgentIdeSettingValue>): void;
}

/**
 * Register once per extension runtime, before or after Agent IDE loads.
 * IDs are unique across owners. Invalid metadata and duplicate IDs are errors.
 * Boolean registrations add menu settings, not command-line flags.
 */
export function registerAgentIdeSettings(
  pi: Pick<ExtensionAPI, "events" | "on">,
  owner: string,
  definitions: readonly AgentIdeSetting[],
): void {
  validateAgentIdeSettings(owner, definitions);
  const snapshot = definitions.map((definition) =>
    Object.freeze({
      ...definition,
      ...(definition.kind === "choice"
        ? { values: Object.freeze(definition.values.map((value) => Object.freeze({ ...value }))) }
        : {}),
      ...(definition.kind === "boolean" && definition.labels
        ? { labels: Object.freeze({ ...definition.labels }) }
        : {}),
    }),
  ) as readonly AgentIdeSetting[];
  const announce = (): boolean => {
    let accepted = false;
    let error: Error | undefined;
    pi.events.emit(SETTINGS_REGISTER_EVENT, {
      owner,
      definitions: snapshot,
      accept(failure) {
        if (accepted) throw new Error("Settings registration was accepted twice");
        accepted = true;
        error = failure;
      },
    } satisfies SettingsRegistration);
    if (error) throw error;
    return accepted;
  };
  let unsubscribe = pi.events.on(SETTINGS_READY_EVENT, () => {
    if (!announce())
      throw new Error("Agent IDE settings announced readiness without accepting registration");
    unsubscribe();
  });
  pi.on("session_shutdown", unsubscribe);
  if (announce()) unsubscribe();
}

/** Read saved effective configuration for this cwd; unavailable services and unknown IDs fail. */
export async function readAgentIdeSetting(
  events: Pick<ExtensionAPI["events"], "emit">,
  id: string,
  cwd: string,
): Promise<AgentIdeSettingValue> {
  let result: Promise<AgentIdeSettingValue> | undefined;
  events.emit(SETTINGS_READ_EVENT, {
    id,
    cwd,
    accept(value) {
      if (result !== undefined) throw new Error("Settings read was accepted twice");
      result = value;
    },
  } satisfies SettingsReadRequest);
  if (result === undefined) throw new Error("Agent IDE settings service is unavailable");
  return result;
}

/** Validate a complete batch before it claims any setting IDs. */
export function validateAgentIdeSettings(
  owner: unknown,
  definitions: unknown,
): asserts definitions is readonly AgentIdeSetting[] {
  if (typeof owner !== "string" || owner.trim().length === 0)
    throw new Error("Settings owner must be non-empty");
  if (!Array.isArray(definitions)) throw new Error("Settings definitions must be an array");
  const batch: readonly unknown[] = definitions;
  const ids = new Set<string>();
  for (const value of batch) {
    const setting = settingRecord(value);
    const id = setting.id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id) || id === "preset")
      throw new Error("Invalid setting ID");
    if (ids.has(id)) throw new Error(`Duplicate setting ID: ${id}`);
    ids.add(id);
    if (
      typeof setting.name !== "string" ||
      !setting.name.trim() ||
      typeof setting.description !== "string" ||
      !setting.description.trim()
    )
      throw new Error(`Setting ${id} needs a name and description`);
    if (setting.group !== undefined && setting.group !== "features" && setting.group !== "ui")
      throw new Error(`Invalid setting group: ${id}`);
    if (setting.kind === "boolean") {
      if (typeof setting.default !== "boolean") throw new Error(`Invalid boolean default: ${id}`);
      if (setting.labels !== undefined) {
        const labels = settingRecord(setting.labels);
        if (
          typeof labels.on !== "string" ||
          typeof labels.off !== "string" ||
          !labels.on.trim() ||
          !labels.off.trim() ||
          labels.on === labels.off ||
          labels.on === "default" ||
          labels.off === "default"
        )
          throw new Error(`Invalid boolean labels: ${id}`);
      }
    } else if (setting.kind === "text" || setting.kind === "choice") {
      if (typeof setting.default !== "string") throw new Error(`Invalid string default: ${id}`);
      if (
        setting.kind === "text" &&
        setting.placeholder !== undefined &&
        typeof setting.placeholder !== "string"
      )
        throw new Error(`Invalid text placeholder: ${id}`);
      if (setting.kind === "choice") {
        const values = new Set<string>();
        const labels = new Set<string>();
        if (!Array.isArray(setting.values) || setting.values.length === 0)
          throw new Error(`Missing setting choices: ${id}`);
        const choices: readonly unknown[] = setting.values;
        for (const value of choices) {
          const choice = settingRecord(value);
          if (
            typeof choice.value !== "string" ||
            !choice.value ||
            typeof choice.label !== "string" ||
            !choice.label.trim() ||
            choice.label === "default" ||
            values.has(choice.value) ||
            labels.has(choice.label)
          )
            throw new Error(`Invalid setting choices: ${id}`);
          values.add(choice.value);
          labels.add(choice.label);
        }
        if (!values.has(setting.default)) throw new Error(`Invalid choice default: ${id}`);
      }
    } else throw new Error(`Unknown setting type: ${id}`);
  }
}

function settingRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid setting metadata");
  return value as Record<string, unknown>;
}
