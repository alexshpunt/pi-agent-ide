import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import linearExtension from "#linear/index.ts";

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
    name: "auth_app_fixture",
    label: "Fixture app sign-in",
    description: "Exercise App sign-in with synthetic consent and a local identity service.",
    parameters: Type.Object({}),
    async execute(_id, _input, _signal, _update, context) {
      if (!handler) throw new Error("Account command was not registered");
      const commandContext = {
        ...context,
        ui: {
          ...context.ui,
          input: async () => "Synthetic app",
          select: async (_title: string, options: string[]) => options[1],
        },
      } as unknown as ExtensionCommandContext;
      await handler("app", commandContext);
      return { content: [{ type: "text", text: "Synthetic App sign-in completed." }], details: {} };
    },
  });
}
