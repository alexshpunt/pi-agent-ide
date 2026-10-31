/** One user-facing Agent IDE preference rendered in the Settings UI. */
interface AgentIdePreferenceBase {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly default: string;
  readonly group: "features" | "ui";
}

export type AgentIdePreference =
  | (AgentIdePreferenceBase & {
      readonly kind: "choice";
      readonly values: readonly { readonly value: string; readonly label: string }[];
    })
  | (AgentIdePreferenceBase & { readonly kind: "text"; readonly placeholder?: string });

function presentationPreference(id: string, name: string, description: string): AgentIdePreference {
  return {
    kind: "choice",
    id,
    name,
    description,
    default: "compact",
    group: "ui",
    values: [
      { value: "full", label: "Full" },
      { value: "compact", label: "Compact" },
      { value: "disabled", label: "Disabled" },
    ],
  };
}

/** Registered presentation preferences. */
export const AGENT_IDE_PREFERENCES: readonly AgentIdePreference[] = [
  {
    kind: "choice",
    id: "search.semantic.engine",
    name: "Semantic search engine",
    description: "Choose the engine used by /semantic-index and semantic_search. Reload to apply.",
    default: "colgrep",
    group: "features",
    values: [
      { value: "colgrep", label: "ColGREP" },
      { value: "vera", label: "Vera" },
    ],
  },
  {
    kind: "choice",
    id: "ui.codemode",
    name: "Show tool results from Codemode",
    description:
      "Show extra Agent IDE result panels using each tool's presentation setting. Off hides successful panels; errors stay visible. Codemode's own output and other tools are unchanged.",
    default: "off",
    group: "ui",
    values: [
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
    ],
  },
  presentationPreference(
    "ui.diffs",
    "Diffs",
    "Choose how mutation and comparison diffs are displayed.",
  ),
  presentationPreference("ui.read", "Read", "Choose how Read calls and results are displayed."),
  presentationPreference(
    "ui.search",
    "Search",
    "Choose how Search calls and results are displayed.",
  ),
  presentationPreference(
    "ui.terminal",
    "Terminal",
    "Choose how shell commands and terminal output are displayed.",
  ),
  {
    kind: "choice",
    id: "processes.activity",
    name: "Active Agent IDE processes",
    description:
      "Choose detailed process cards, a compact active count, or no persistent Agent IDE process UI.",
    default: "detailed",
    group: "ui",
    values: [
      { value: "detailed", label: "Detailed cards" },
      { value: "compact", label: "Compact count" },
      { value: "off", label: "Off" },
    ],
  },
];
