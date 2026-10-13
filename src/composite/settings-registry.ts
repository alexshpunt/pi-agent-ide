import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SETTINGS_READ_EVENT,
  SETTINGS_READY_EVENT,
  SETTINGS_REGISTER_EVENT,
  validateAgentIdeSettings,
  type AgentIdeSetting,
  type AgentIdeSettingValue,
  type SettingsReadRequest,
  type SettingsRegistration,
} from "#src/api/settings.js";
import {
  configuredFeatureFlags,
  readExtensionSettingsScope,
  resolvePiAgentIdeExtensionsConfigPaths,
} from "./extensions-config.js";
import type { FeatureFlag } from "./feature-flags.js";
import type { AgentIdePreference } from "./preferences.js";

/** One host-owned registry supplies the menu, catalog and effective settings reads. */
export function createAgentIdeSettingsRegistry(
  pi: Pick<ExtensionAPI, "events" | "on">,
  builtInFlags: readonly FeatureFlag[],
  builtInPreferences: readonly AgentIdePreference[],
) {
  const settings = new Map<
    string,
    { readonly owner: string; readonly definition: AgentIdeSetting }
  >();
  const flags: FeatureFlag[] = [];
  const preferences: AgentIdePreference[] = [];
  function register(owner: string, definitions: readonly AgentIdeSetting[]): void {
    validateAgentIdeSettings(owner, definitions);
    for (const definition of definitions) {
      const existing = settings.get(definition.id);
      if (existing)
        throw new Error(`Setting ${definition.id} is already registered by ${existing.owner}`);
    }
    for (const definition of definitions) {
      settings.set(definition.id, { owner, definition });
      if (definition.kind === "boolean") {
        const { kind: _kind, group, ...flag } = definition;
        flags.push({ ...flag, ...(group === "ui" ? { group } : {}) });
      } else preferences.push({ ...definition, group: definition.group ?? "features" });
    }
  }
  register("pi-agent-ide", [
    ...builtInFlags.map((flag): AgentIdeSetting => ({ ...flag, kind: "boolean" })),
    ...builtInPreferences,
  ]);

  async function read(id: string, cwd: string): Promise<AgentIdeSettingValue> {
    const setting = settings.get(id)?.definition;
    if (!setting) throw new Error(`Unknown Agent IDE setting: ${id}`);
    const paths = resolvePiAgentIdeExtensionsConfigPaths(process.env, undefined, cwd);
    const [global, project] = await Promise.all([
      readExtensionSettingsScope(paths.globalPath),
      readExtensionSettingsScope(paths.projectPath),
    ]);
    const saved =
      setting.kind === "boolean"
        ? { ...configuredFeatureFlags(global), ...configuredFeatureFlags(project) }
        : { ...global.preferences, ...project.preferences };
    const overridden = Object.hasOwn(saved, id);
    const value = overridden ? saved[id] : setting.default;
    if (
      value === undefined ||
      (setting.kind === "boolean" ? typeof value !== "boolean" : typeof value !== "string")
    )
      throw new Error(`Invalid saved setting type: ${id}`);
    if (setting.kind === "choice" && !setting.values.some((choice) => choice.value === value))
      throw new Error(`Invalid saved setting choice: ${id}`);
    return { value, overridden };
  }
  const unsubscribeRegistration = pi.events.on(SETTINGS_REGISTER_EVENT, (data) => {
    const request = data as SettingsRegistration;
    try {
      register(request.owner, request.definitions);
      request.accept();
    } catch (error) {
      request.accept(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const unsubscribeRead = pi.events.on(SETTINGS_READ_EVENT, (data) => {
    const request = data as SettingsReadRequest;
    request.accept(read(request.id, request.cwd));
  });
  pi.on("session_shutdown", () => {
    unsubscribeRegistration();
    unsubscribeRead();
  });
  pi.events.emit(SETTINGS_READY_EVENT, undefined);
  return { flags, preferences, read };
}
