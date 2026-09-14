/** One user-facing Agent IDE preference rendered in the Settings UI. */
export interface AgentIdePreference {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly default: string;
  readonly group: "ui";
  readonly values: readonly { readonly value: string; readonly label: string }[];
}

/** Registered presentation preferences. */
export const AGENT_IDE_PREFERENCES: readonly AgentIdePreference[] = [
  {
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
