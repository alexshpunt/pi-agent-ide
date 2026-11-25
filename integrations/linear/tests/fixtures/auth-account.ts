import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import linearExtension from "#linear/index.ts";
import { MaskedAuthInput } from "#linear/auth-ui.ts";
import { LoginDialogComponent } from "@earendil-works/pi-coding-agent";

export default async function fixture(pi: ExtensionAPI) {
  let handler: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
  await linearExtension(
    new Proxy(pi, {
      get(target, name) {
        if (name === "registerCommand")
          return (command: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
            if (command === "linear") handler = definition.handler;
            return target.registerCommand(command, definition);
          };
        return Reflect.get(target, name);
      },
    }),
  );
  pi.registerTool({
    name: "auth_account_fixture",
    label: "Fixture account action",
    description:
      "Exercise the production Linear account command with synthetic human input and no remote authorization.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("logout"),
        Type.Literal("connect-b"),
        Type.Literal("login"),
        Type.Literal("login-cancel"),
        Type.Literal("revoke"),
      ]),
    }),
    async execute(_id, input, _signal, _update, context) {
      if (!handler) throw new Error("Account command was not registered");
      const custom = context.ui.custom.bind(context.ui);
      let busyStep = 0;
      const commandContext = {
        ...context,
        ui: {
          ...context.ui,
          confirm: (title: string, message: string) =>
            ["revoke", "logout"].includes(input.action)
              ? Promise.resolve(true)
              : context.ui.confirm(title, message),
          input: async () => "Synthetic account",
          select: (title: string, options: string[]) =>
            title === "Requested Linear access"
              ? Promise.resolve("Read only")
              : title === "Log out of a Linear connection" ? Promise.resolve(options[0]) : title === "Linear" ? Promise.resolve(undefined) : context.ui.select(title, options),
          custom: (factory: Parameters<typeof custom>[0], options?: Parameters<typeof custom>[1]) =>
            custom(async (tui, theme, keys, done) => {
              const component = await factory(tui, theme, keys, done);
              if (component instanceof MaskedAuthInput) {
                queueMicrotask(() => component.handleInput("synthetic-key-never-logged"));
                setTimeout(() => component.handleInput("\r"), 400);
              }
              if (input.action === "login-cancel" && component instanceof LoginDialogComponent)
                setTimeout(() => component.handleInput("\x1b"), 600);
              if (input.action === "revoke" && ++busyStep === 2)
                setTimeout(() => component.handleInput?.("\x1b"), 400);
              return component;
            }, options),
        },
      } as unknown as ExtensionCommandContext;
      await handler(input.action === "connect-b" ? "key" : input.action === "login-cancel" ? "login" : input.action, commandContext);
      return {
        content: [{ type: "text", text: `Completed synthetic account action: ${input.action}` }],
        details: { action: input.action },
      };
    },
  });
}
