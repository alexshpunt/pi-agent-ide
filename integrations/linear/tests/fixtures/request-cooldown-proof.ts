import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import linearExtension from "#linear/index.ts";

/** Keep the production auth command and Read provider in the real Pi process. */
export default async function requestCooldownFixture(pi: ExtensionAPI) {
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
    name: "request_cooldown_control",
    label: "Request cooldown fixture",
    description:
      "Use request_cooldown_control to select the synthetic Work connection or control the local test server.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("select-work"),
        Type.Literal("snapshot"),
        Type.Literal("arm"),
      ]),
    }),
    async execute(_id, input, _signal, _update, context) {
      if (input.action === "select-work") {
        if (!auth) throw Error("REQUEST_COOLDOWN_AUTH_COMMAND_MISSING");
        const ctx = {
          ...context,
          ui: {
            ...context.ui,
            select: async (_title: string, labels: string[]) =>
              labels.find((label) => label.includes("Work")),
          },
        } as unknown as ExtensionCommandContext;
        await auth("switch", ctx);
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
      }
      const address = process.env.LINEAR_TEST_REQUEST_COOLDOWN_CONTROL;
      if (!address) throw Error("REQUEST_COOLDOWN_CONTROL_MISSING");
      const url = new URL(address);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password)
        throw Error("REQUEST_COOLDOWN_CONTROL_INVALID");
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: input.action }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Error("REQUEST_COOLDOWN_CONTROL_FAILED");
      const data: unknown = await response.json();
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
    },
  });
}
