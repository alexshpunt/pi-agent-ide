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

/** Registered presentation preferences. */
export const AGENT_IDE_PREFERENCES: readonly AgentIdePreference[] = [
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
