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
  presentationPreference(
    "ui.applyPreview",
    "Apply preview",
    "Choose how Apply source previews are displayed.",
  ),
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
  {
    kind: "text",
    id: "vision.sequenceDurationSeconds",
    name: "Vision sequence duration",
    description:
      "Default sequence duration in seconds. Requests may override it, up to 10 seconds.",
    default: "2",
    group: "features",
  },
  {
    kind: "text",
    id: "vision.sequenceIntervalSeconds",
    name: "Vision sequence interval",
    description:
      "Default seconds between sequence frames. A sequence may contain at most 20 frames.",
    default: "0.5",
    group: "features",
  },
  {
    kind: "text",
    id: "vision.imageScale",
    name: "Vision image scale",
    description: "Default image downscale from greater than 0 through 1.",
    default: "0.5",
    group: "features",
  },
  {
    kind: "text",
    id: "vision.allowedExecutables",
    name: "Vision allowed executables",
    description:
      "Comma-separated executable file names that may be captured without arbitrary-window access.",
    default: "",
    group: "features",
    placeholder: "Unity.exe,UnrealEditor.exe",
  },
];
