import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input } from "@earendil-works/pi-tui";
import { BUILTIN_EXTENSIONS } from "./builtin-extensions.js";
import {
  configuredFeatureFlags,
  readExtensionSettingsScope,
  resolvePiAgentIdeExtensionsConfigPaths,
} from "./extensions-config.js";
import type { FeatureFlag } from "./feature-flags.js";
import type { AgentIdePreference } from "./preferences.js";
import { AGENT_IDE_PRESET_OPTIONS, disabledByPreset, type AgentIdePreset } from "./presets.js";
import { saveModuleChoices, type ModuleChoice } from "./module-settings-store.js";
import { createSettingsPanel } from "./settings-panel.js";
import { selectBuiltinExtensions } from "./selection.js";

/** Keep settings available even when every optional module is disabled. */
export function registerModuleSettings(
  pi: Pick<ExtensionAPI, "registerCommand">,
  flags: readonly FeatureFlag[] = [],
  preferences: readonly AgentIdePreference[] = [],
): void {
  pi.registerCommand("agent-ide-settings", {
    description: "Configure Agent IDE modules and features",
    async handler(_args, ctx) {
      if (!ctx.hasUI) return;
      try {
        const scope = await ctx.ui.select("Agent IDE settings — save scope", ["Project", "Global"]);
        if (scope === undefined) return;
        const paths = resolvePiAgentIdeExtensionsConfigPaths(process.env, undefined, ctx.cwd);
        const selectedPath = scope === "Project" ? paths.projectPath : paths.globalPath;
        const current = await readExtensionSettingsScope(selectedPath);
        const other = await readExtensionSettingsScope(
          scope === "Project" ? paths.globalPath : paths.projectPath,
        );
        const choices = new Map<string, ModuleChoice>();
        const featureChoices = new Map<string, boolean | undefined>();
        const preferenceChoices = new Map<string, string | undefined>();
        let presetChoice: AgentIdePreset | undefined;
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
                  ...disabledByPreset(BUILTIN_EXTENSIONS, presetChoice ?? current.preset ?? "full"),
                  ...disabled,
                  ...disabledByPreset(BUILTIN_EXTENSIONS, other.preset ?? "full"),
                  ...other.disabled,
                ],
                [...enabled, ...other.enabled],
              );
              return {
                modules: BUILTIN_EXTENSIONS.map((module) => ({
                  id: module.id,
                  label: module.name ?? module.id,
                  description: `${module.description ?? ""} Effective: ${effective.disabled.has(module.id) ? "off" : "on"}.${other.disabled.includes(module.id) ? " Disabled in the other scope." : module.dependencies.some((id) => effective.disabled.has(id)) ? " A dependency is disabled." : ""}`,
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
                const value = presetChoice ?? current.preset ?? "full";
                return {
                  id: "preset",
                  label: "Preset",
                  description: "Choose the built-in Agent IDE capability set. Reload required.",
                  currentValue:
                    AGENT_IDE_PRESET_OPTIONS.find((item) => item.value === value)?.label ?? value,
                  values: AGENT_IDE_PRESET_OPTIONS.map((item) => item.label),
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
                      label: preference.name,
                      description: `${preference.description} Default: ${preference.kind === "choice" ? (preference.values.find((item) => item.value === preference.default)?.label ?? preference.default) : preference.default || "empty"}.`,
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
                      label: flag.name,
                      description: flag.description,
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
              if (tab === "modules") choices.set(id, value as ModuleChoice);
              else if (id === "preset") {
                presetChoice = AGENT_IDE_PRESET_OPTIONS.find((item) => item.label === value)?.value;
              } else if (preferences.some((item) => item.id === id)) {
                const preference = preferences.find((item) => item.id === id);
                preferenceChoices.set(
                  id,
                  value === "default" || value.length === 0
                    ? undefined
                    : preference?.kind === "choice"
                      ? preference.values.find((item) => item.label === value)?.value
                      : value,
                );
              } else {
                featureChoices.set(
                  id,
                  value === "default"
                    ? undefined
                    : value === (flags.find((flag) => flag.id === id)?.labels?.on ?? "enabled"),
                );
              }
            },
            done,
            scope,
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
          !saved ||
          choices.size +
            featureChoices.size +
            preferenceChoices.size +
            (presetChoice === undefined ? 0 : 1) ===
            0
        )
          return;
        await saveModuleChoices(
          selectedPath,
          choices,
          featureChoices,
          preferenceChoices,
          presetChoice,
        );
        ctx.ui.notify(`Saved ${scope.toLowerCase()} Agent IDE settings. Reload required.`, "info");
        if (
          await ctx.ui.confirm(
            "Reload Pi?",
            "Reload extensions to apply settings. In-memory extension state may reset.",
          )
        ) {
          await ctx.reload();
          return;
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
