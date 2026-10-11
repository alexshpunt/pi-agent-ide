import { TIP_API_VERSION, TIP_PROTOCOL, type TipProvider } from "#src/api/tips.js";

/** Creates a global setup hint when the setup skill is available in an interactive session. */
export function createSetupHintProvider(hasSkill: () => boolean): TipProvider {
  return {
    protocol: TIP_PROTOCOL,
    apiVersion: TIP_API_VERSION,
    id: "agent-setup",
    getTip(context) {
      if (context.mode !== "tui" || !context.hasUI || !hasSkill()) return undefined;
      return {
        id: "agent-setup-v1",
        scope: "global",
        title: "Agent-assisted setup",
        body: "You can ask your agent to configure Pi Agent IDE.\nTry: “Help me configure Pi Agent IDE for this project.”\nOr open /agent-ide-settings.",
      };
    },
  };
}
