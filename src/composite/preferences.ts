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
    id: "terminal.activity",
    name: "Active terminal display",
    description:
      "Choose detailed terminal cards, a compact active count, or no persistent terminal activity UI.",
    default: "detailed",
    group: "ui",
    values: [
      { value: "detailed", label: "Detailed cards" },
      { value: "compact", label: "Compact count" },
      { value: "off", label: "Off" },
    ],
  },
];
