import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import linearExtension from "#linear/index.ts";

/** Exercise the production session-selection UI and creation provider in an isolated Pi. */
export default async function contextualCommentProof(pi: ExtensionAPI) {
  let auth: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
  await linearExtension(
    new Proxy(pi, {
      get(target, name) {
        if (name === "registerCommand")
          return (command: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
            if (command === "linear") auth = definition.handler;
            return target.registerCommand(command, definition);
          };
        return Reflect.get(target, name);
      },
    }),
  );
  pi.registerTool({
    name: "comment_proof_control",
    label: "Comment proof",
    description:
      "Use comment_proof_control to select the synthetic connection or request an explicit test persona.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("select"), Type.Literal("connect-app"), Type.Literal("require-persona")]),
    }),
    async execute(_id, input, _signal, _update, context) {
      if (input.action === "require-persona") {
        process.env.LINEAR_AXI_ROLE = "qa";
        return {
          content: [{ type: "text", text: JSON.stringify({ configured: true }) }],
          details: { configured: true },
        };
      }
      if (!auth) throw Error("COMMENT_PROOF_AUTH_COMMAND_MISSING");
      const selected = {
        ...context,
        ui: {
          ...context.ui,
          input: async () => "Connected installed App",
          select: async (_title: string, labels: string[]) =>
            input.action === "connect-app" ? labels[0] : labels.find((label) => label.includes("Comment connection")),
        },
      } as unknown as ExtensionCommandContext;
      await auth(input.action === "connect-app" ? "app" : "switch", selected);
      const entry = context.sessionManager
        .getEntries()
        .findLast(
          (value) =>
            value.type === "custom" &&
            value.customType === "linear-connection" &&
            (value.data as { sessionId?: string } | undefined)?.sessionId ===
              context.sessionManager.getSessionId(),
        );
      const selection = entry?.type === "custom" ? entry.data : null;
      return {
        content: [{ type: "text", text: JSON.stringify({ selection }) }],
        details: { selection },
      };
    },
  });
}
