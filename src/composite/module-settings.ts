import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input } from "@earendil-works/pi-tui";
import { BUILTIN_EXTENSIONS } from "./builtin-extensions.js";
import {
  configuredFeatureFlags,
  readExtensionSettingsScope,
  readPiAgentIdeExtensionsConfig,
  resolvePiAgentIdeExtensionsConfigPaths,
  type PiAgentIdeExtensionsConfig,
} from "./extensions-config.js";
import type { FeatureFlag } from "./feature-flags.js";
import type { AgentIdePreference } from "./preferences.js";
import { AGENT_IDE_PRESET_OPTIONS, disabledByPreset, type AgentIdePreset } from "./presets.js";
import { saveModuleChoices, type ModuleChoice } from "./module-settings-store.js";
import { createSettingsPanel } from "./settings-panel.js";
import { selectBuiltinExtensions } from "./selection.js";
import {
  flagRequiresReload,
  pendingReloadChanges,
  preferenceRequiresReload,
} from "./reload-required.js";
import { IDE_PRESENTATION_CHANGED } from "./live-presentation.js";
import { IDE_FEATURE_FLAGS_CHANGED } from "#src/core/live-feature-flag.js";
import {
  SEMANTIC_SETTINGS_CHANGED_EVENT,
  type SemanticSettingsChanged,
} from "#src/semantic/extension.js";

/** Keep settings available even when every optional module is disabled. */
export function registerModuleSettings(
  pi: Pick<ExtensionAPI, "registerCommand"> & Partial<Pick<ExtensionAPI, "events">>,
  flags: readonly FeatureFlag[] = [],
  preferences: readonly AgentIdePreference[] = [],
  initialConfig?: PiAgentIdeExtensionsConfig,
): void {
  let runningConfig = initialConfig;
  pi.registerCommand("agent-ide-settings", {
    description: "Configure Agent IDE modules and features",
    async handler(_args, ctx) {
      if (!ctx.hasUI) return;
      try {
        const scope = await ctx.ui.select("Agent IDE settings — save scope", ["Project", "Global"]);
        if (scope === undefined) return;
        const paths = resolvePiAgentIdeExtensionsConfigPaths(process.env, undefined, ctx.cwd);
        const before = await readPiAgentIdeExtensionsConfig(paths);
        runningConfig ??= before;
        const cliFlags = new Set(
          flags
            .filter((flag) =>
              process.argv.some((arg) => arg === `--${flag.id}` || arg.startsWith(`--${flag.id}=`)),
            )
            .map((flag) => flag.id),
        );
        const pendingNames = new Set(
          pendingReloadChanges(
            runningConfig,
            before,
            BUILTIN_EXTENSIONS,
            flags,
            preferences,
            cliFlags,
          ),
        );
        const selectedPath = scope === "Project" ? paths.projectPath : paths.globalPath;
        const current = await readExtensionSettingsScope(selectedPath);
        const other = await readExtensionSettingsScope(
          scope === "Project" ? paths.globalPath : paths.projectPath,
        );
        const choices = new Map<string, ModuleChoice>();
        const featureChoices = new Map<string, boolean | undefined>();
        const preferenceChoices = new Map<string, string | undefined>();
        let presetChoice: AgentIdePreset | null | undefined;
        const saved = await ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
          const panel = createSettingsPanel(
            theme,
            () => {
              const disabled = new Set(current.disabled);
              const enabled = new Set(current.enabled);
              for (const [id, choice] of choices) {
                disabled.delete(id);
                enabled.delete(id);
                if (choice === "disabled") disabled.add(id);
                if (choice === "enabled") enabled.add(id);
              }
              const effective = selectBuiltinExtensions(
                BUILTIN_EXTENSIONS,
                [
                  ...disabledByPreset(
                    BUILTIN_EXTENSIONS,
                    scope === "Project"
                      ? ((presetChoice === undefined ? current.preset : presetChoice) ??
                          other.preset ??
                          "full")
                      : (other.preset ??
                          (presetChoice === undefined ? current.preset : presetChoice) ??
                          "full"),
                  ),
                  ...disabled,
                  ...other.disabled,
                ],
                [...enabled, ...other.enabled],
              );
              return {
                modules: BUILTIN_EXTENSIONS.map((module) => ({
                  id: module.id,
                  label: `${module.name ?? module.id}${pendingNames.has(module.name ?? module.id) ? " *" : ""}`,
                  description: `${module.description ?? ""} Reload required for changes. Effective: ${effective.disabled.has(module.id) ? "off" : "on"}.${other.disabled.includes(module.id) ? " Disabled in the other scope." : module.dependencies.some((id) => effective.disabled.has(id)) ? " A dependency is disabled." : ""}`,
                  currentValue:
                    choices.get(module.id) ??
                    (current.disabled.includes(module.id)
                      ? "disabled"
                      : current.enabled.includes(module.id)
                        ? "enabled"
                        : "default"),
                  values: ["default", "enabled", "disabled"],
                })),
                features: [presetItem(), ...flagItems("features"), ...preferenceItems("features")],
                ui: [...flagItems("ui"), ...preferenceItems("ui")],
              };
              function presetItem() {
                const value = presetChoice === undefined ? current.preset : presetChoice;
                return {
                  id: "preset",
                  label: "Preset",
                  description: "Choose the built-in Agent IDE capability set. Reload required.",
                  currentValue:
                    AGENT_IDE_PRESET_OPTIONS.find((item) => item.value === value)?.label ??
                    "default",
                  values: ["default", ...AGENT_IDE_PRESET_OPTIONS.map((item) => item.label)],
                };
              }
              function preferenceItems(group: "features" | "ui") {
                return preferences
                  .filter((preference) => preference.group === group)
                  .map((preference) => {
                    const configured = preferenceChoices.has(preference.id)
                      ? preferenceChoices.get(preference.id)
                      : current.preferences?.[preference.id];
                    return {
                      id: preference.id,
                      label: `${preference.name}${pendingNames.has(preference.name) ? " *" : ""}`,
                      description: `${preference.description}${preferenceRequiresReload(preference.id) ? " Reload required for changes." : ""} Default: ${preference.kind === "choice" ? (preference.values.find((item) => item.value === preference.default)?.label ?? preference.default) : preference.default || "empty"}.`,
                      currentValue:
                        configured === undefined
                          ? "default"
                          : preference.kind === "choice"
                            ? (preference.values.find((item) => item.value === configured)?.label ??
                              configured)
                            : configured,
                      ...(preference.kind === "choice"
                        ? { values: ["default", ...preference.values.map((item) => item.label)] }
                        : {
                            submenu: (currentValue: string, done: (value?: string) => void) => {
                              const input = new Input();
                              const initial =
                                currentValue === "default" ? preference.default : currentValue;
                              if (initial.length > 0) input.handleInput(initial);
                              input.focused = true;
                              input.onSubmit = (value) => done(value);
                              input.onEscape = () => done();
                              return input;
                            },
                          }),
                    };
                  });
              }
              function flagItems(group: "features" | "ui") {
                return flags
                  .filter((flag) => (flag.group ?? "features") === group)
                  .map((flag) => {
                    const value = featureChoices.has(flag.id)
                      ? featureChoices.get(flag.id)
                      : configuredFeatureFlags(current)[flag.id];
                    return {
                      id: flag.id,
                      label: `${flag.name}${pendingNames.has(flag.name) ? " *" : ""}`,
                      description: `${flag.description}${flagRequiresReload(flag.id) ? " Reload required for changes." : ""}`,
                      currentValue:
                        value === undefined
                          ? "default"
                          : value
                            ? (flag.labels?.on ?? "enabled")
                            : (flag.labels?.off ?? "disabled"),
                      values: [
                        "default",
                        flag.labels?.off ?? "disabled",
                        flag.labels?.on ?? "enabled",
                      ],
                    };
                  });
              }
            },
            (tab, id, value) => {
              if (tab === "modules") {
                const original = current.disabled.includes(id)
                  ? "disabled"
                  : current.enabled.includes(id)
                    ? "enabled"
                    : "default";
                if (value === original) choices.delete(id);
                else choices.set(id, value as ModuleChoice);
              } else if (id === "preset") {
                const next =
                  AGENT_IDE_PRESET_OPTIONS.find((item) => item.label === value)?.value ?? null;
                presetChoice = next === (current.preset ?? null) ? undefined : next;
              } else if (preferences.some((item) => item.id === id)) {
                const preference = preferences.find((item) => item.id === id);
                const next =
                  value === "default" || value.length === 0
                    ? undefined
                    : preference?.kind === "choice"
                      ? preference.values.find((item) => item.label === value)?.value
                      : value;
                if (next === current.preferences?.[id]) preferenceChoices.delete(id);
                else preferenceChoices.set(id, next);
              } else {
                const next =
                  value === "default"
                    ? undefined
                    : value === (flags.find((flag) => flag.id === id)?.labels?.on ?? "enabled");
                if (next === configuredFeatureFlags(current)[id]) featureChoices.delete(id);
                else featureChoices.set(id, next);
              }
            },
            done,
            `${scope}${pendingNames.size ? " · * reload pending" : ""}`,
          );
          return {
            render: (width) => panel.render(width),
            invalidate: () => panel.invalidate(),
            handleInput(data) {
              panel.handleInput(data);
              tui.requestRender();
            },
          };
        });
        if (
          choices.size +
            featureChoices.size +
            preferenceChoices.size +
            (presetChoice === undefined ? 0 : 1) ===
          0
        )
          return;
        if (!saved && !(await ctx.ui.confirm("Unsaved changes", "Save changes?"))) return;
        await saveModuleChoices(
          selectedPath,
          choices,
          featureChoices,
          preferenceChoices,
          presetChoice,
        );
        const effective = await readPiAgentIdeExtensionsConfig(paths);
        for (const preference of preferences) {
          const value = effective.preferences?.[preference.id];
          if (
            value !== undefined &&
            preference.kind === "choice" &&
            !preference.values.some((item) => item.value === value)
          )
            throw new Error(`Saved settings contain an invalid choice: ${preference.id}`);
        }
        pi.events?.emit(IDE_PRESENTATION_CHANGED, { preferences: effective.preferences ?? {} });
        pi.events?.emit(IDE_FEATURE_FLAGS_CHANGED, { flags: configuredFeatureFlags(effective) });
        const refreshes: Promise<void>[] = [];
        pi.events?.emit(SEMANTIC_SETTINGS_CHANGED_EVENT, {
          cwd: ctx.cwd,
          waitUntil: (promise) => refreshes.push(promise),
        } satisfies SemanticSettingsChanged);
        await Promise.all(refreshes);
        const pending = pendingReloadChanges(
          runningConfig,
          effective,
          BUILTIN_EXTENSIONS,
          flags,
          preferences,
          cliFlags,
        );
        ctx.ui.setStatus(
          "pi-agent-ide-reload",
          pending.length ? `Reload required (${pending.length}; see settings)` : undefined,
        );
        if (pending.length === 0) {
          ctx.ui.notify(`Saved ${scope.toLowerCase()} Agent IDE settings.`, "info");
          return;
        }
        ctx.ui.notify(
          `Saved ${scope.toLowerCase()} Agent IDE settings. Reload required: ${pending.join(", ")}.`,
          "info",
        );
        if (
          await ctx.ui.confirm(
            "Reload Pi?",
            "Reload extensions to apply pending settings. In-memory extension state may reset.",
          )
        ) {
          await ctx.reload();
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
