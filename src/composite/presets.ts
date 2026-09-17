import type { BuiltinExtension } from "./selection.js";

/** Agent IDE capability presets saved in extension settings. */
export type AgentIdePreset = "full" | "text-editor";

/** Human-facing preset choices shown by the settings UI. */
export const AGENT_IDE_PRESET_OPTIONS: readonly {
  readonly value: AgentIdePreset;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: "full",
    label: "Full IDE",
    description: "Load every built-in Agent IDE extension unless it is explicitly disabled.",
  },
  {
    value: "text-editor",
    label: "Text Editor",
    description: "Load text read, search, editing, anchors, and AST only.",
  },
];

const TEXT_EDITOR_EXTENSION_IDS = new Set([
  "ide.core",
  "ide.tips",
  "read.core",
  "read.filesystem",
  "read.filesystem.text",
  "search.core",
  "search.text",
  "editor.core",
  "editor.renderer",
  "editor.anchor.constant",
  "editor.anchor.line-hash",
  "editor.anchor.exact",
  "editor.stale-anchor",
  "ide.ast",
]);

/** Return the built-in IDs disabled by a preset before explicit user choices are applied. */
export function disabledByPreset(
  extensions: readonly Pick<BuiltinExtension, "id">[],
  preset: AgentIdePreset,
): readonly string[] {
  if (preset === "full") return [];
  return extensions
    .map((extension) => extension.id)
    .filter((id) => !TEXT_EDITOR_EXTENSION_IDS.has(id));
}

/** Validate a configured Agent IDE preset. */
export function readAgentIdePreset(value: unknown, configPath: string): AgentIdePreset | undefined {
  if (value === undefined) return undefined;
  if (value === "full" || value === "text-editor") return value;
  throw new Error(`preset in ${configPath} must be one of: full, text-editor`);
}
