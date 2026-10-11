import type { AgentDocumentation } from "#src/api/documentation.js";
import { BUILTIN_EXTENSIONS } from "./builtin-extensions.js";
import type { FeatureFlag } from "./feature-flags.js";
import { AGENT_IDE_PREFERENCES } from "./preferences.js";
import { AGENT_IDE_PRESET_OPTIONS } from "./presets.js";

/** Build an explicit, read-only guide from the same descriptors as the settings menu. */
export function createIdeSettingsDocumentation(flags: readonly FeatureFlag[]): AgentDocumentation {
  const catalog = {
    preferences: AGENT_IDE_PREFERENCES,
    flags,
    modules: BUILTIN_EXTENSIONS.map(({ id, name, description, defaultEnabled, dependencies }) => ({
      id,
      name,
      description,
      default: defaultEnabled !== false,
      dependencies,
    })),
    presets: AGENT_IDE_PRESET_OPTIONS,
  };
  const json = Object.entries(catalog)
    .map(
      ([name, entries]) =>
        `  "${name}": [\n${entries.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n")}\n  ]`,
    )
    .join(",\n");
  return {
    id: "ide-settings",
    description:
      "Registered IDE settings, choices, defaults, configuration scopes and inheritance.",
    triggers: [{ tool: "read", resourcePrefixes: ["docs:ide-settings"] }],
    markdown: `# IDE settings

This catalog describes supported settings, not current saved values or live runtime state. It is generated from the registrations used by /agent-ide-settings. Read both configuration scopes to inspect overrides. Reload or restart applies saved changes; CLI flags may override them for an invocation.

## Configuration scopes

- Project: <current project>/.pi/pi-agent-ide/extensions.json.
- Global: <PI_CODING_AGENT_DIR>/pi-agent-ide/extensions.json when that environment variable is non-empty; otherwise <home>/.pi/agent/pi-agent-ide/extensions.json. Resolve a relative PI_CODING_AGENT_DIR against the process working directory.
- Missing files mean no overrides. Invalid JSON or invalid field types are errors, not defaults.
- preferences maps registered IDs to strings; flags maps registered IDs to booleans. Project overrides Global per key. Default removes only the selected scope's key, allowing inheritance.
- preset is a registered preset value. Project overrides Global; without either, full is used. Default removes the selected scope's preset field.
- disabled and enabled are arrays of unique non-empty module IDs, merged across scopes. Disabled wins in either scope and cascades to dependents. enabled can activate default-off modules and dependencies; it cannot undo a disable or a preset restriction.
- A module's default below is its built-in default before preset and dependency selection, not its current effective state.
- Existing noAnimations and noPostProcessing booleans still work. Their registered flags are pi-agent-ide-no-animations and pi-agent-ide-no-post-processing. Within each scope a flags entry wins over its corresponding legacy boolean. When changing or resetting that flag, remove its legacy boolean in the same scope, as the menu does.
- Text preference values are strings, not JSON numbers. An empty default means no override; saved strings must be non-empty. Read each description for valid ranges. Do not treat storage validation as validation of every preference value.

## Registered settings

Choices carry their saved value and human label. Text settings carry a description and optional placeholder. Boolean flag defaults do not include saved or CLI overrides. Preserve unrelated fields when editing configuration.

\`\`\`json
{
${json}
}
\`\`\`
`,
  };
}
