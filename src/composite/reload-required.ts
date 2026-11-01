import type { PiAgentIdeExtensionsConfig } from "./extensions-config.js";
import { configuredFeatureFlags } from "./extensions-config.js";
import type { FeatureFlag } from "./feature-flags.js";
import type { AgentIdePreference } from "./preferences.js";
import { disabledByPreset } from "./presets.js";
import { selectBuiltinExtensions, type BuiltinExtension } from "./selection.js";

// These settings are consumed dynamically. Unknown extension settings are conservative:
// their owner may have read the value only during registration.
const LIVE_FLAGS = new Set([
  "pi-agent-ide-yolo",
  "pi-agent-ide-filesystem-yolo",
  "pi-agent-ide-no-post-processing",
  "pi-agent-ide-no-animations",
  "pi-agent-ide-code-review",
  "pi-agent-ide-code-review-capture",
]);
const LIVE_PREFERENCES = new Set([
  "search.semantic.engine",
  "ui.codemode",
  "ui.diffs",
  "ui.read",
  "ui.search",
  "ui.terminal",
  "processes.activity",
]);

/** Unknown registrations are reload-only until their owner declares a live lifecycle. */
export function flagRequiresReload(id: string): boolean {
  return !LIVE_FLAGS.has(id);
}

export function preferenceRequiresReload(id: string): boolean {
  return !LIVE_PREFERENCES.has(id);
}
/** Compare effective startup-only settings with the running extension's startup snapshot. */
export function pendingReloadChanges(
  running: PiAgentIdeExtensionsConfig,
  configured: PiAgentIdeExtensionsConfig,
  modules: readonly BuiltinExtension[],
  flags: readonly FeatureFlag[],
  preferences: readonly AgentIdePreference[],
  cliFlags: ReadonlySet<string> = new Set(),
): string[] {
  const selected = (config: PiAgentIdeExtensionsConfig) =>
    selectBuiltinExtensions(
      modules,
      [...disabledByPreset(modules, config.preset ?? "full"), ...config.disabled],
      config.enabled,
    ).disabled;
  const runningDisabled = selected(running);
  const configuredDisabled = selected(configured);
  const pending = modules
    .filter((module) => runningDisabled.has(module.id) !== configuredDisabled.has(module.id))
    .map((module) => module.name ?? module.id);
  const oldFlags = configuredFeatureFlags(running);
  const newFlags = configuredFeatureFlags(configured);
  for (const flag of flags) {
    if (
      flagRequiresReload(flag.id) &&
      !cliFlags.has(flag.id) &&
      (oldFlags[flag.id] ?? flag.default) !== (newFlags[flag.id] ?? flag.default)
    ) pending.push(flag.name);
  }
  for (const preference of preferences) {
    if (
      preferenceRequiresReload(preference.id) &&
      (running.preferences?.[preference.id] ?? preference.default) !==
        (configured.preferences?.[preference.id] ?? preference.default)
    ) pending.push(preference.name);
  }
  return pending;
}
