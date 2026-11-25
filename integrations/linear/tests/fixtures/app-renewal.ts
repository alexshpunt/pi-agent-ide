import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import linearExtension from "#linear/index.ts";
import { runAuthCommand } from "#linear/auth-process.ts";

export default async function fixture(pi: ExtensionAPI) {
  let handler: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
  await linearExtension(new Proxy(pi, {
    get(target, name) {
      if (name === "registerCommand")
        return (command: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
          if (command === "linear") handler = definition.handler;
          return target.registerCommand(command, definition);
        };
      return Reflect.get(target, name);
    },
  }));
  pi.registerTool({
    name: "app_renewal_fixture",
    label: "Fixture App connection status",
    description: "Inspect the selected synthetic App connection through the production command.",
    parameters: Type.Object({}),
    async execute(_id, _input, _signal, _update, context) {
      if (!handler) throw new Error("Linear command was not registered");
      await handler("status", context as unknown as ExtensionCommandContext);
      const entry = context.sessionManager.getEntries().findLast((item) =>
        item.type === "custom" && item.customType === "linear-connection" &&
        (item.data as { sessionId?: string } | undefined)?.sessionId === context.sessionManager.getSessionId(),
      );
      const selection = entry?.type === "custom" ? entry.data as { connectionId?: string } : undefined;
      const status = await runAuthCommand(context.cwd, ["epoch"], {
        connectionId: selection?.connectionId,
        signal: context.signal,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ selection, status }) }],
        details: { selection, status },
      };
    },
  });
}
