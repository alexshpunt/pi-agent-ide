import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import linearExtension from "#linear/index.ts";
import { MaskedAuthInput } from "#linear/auth-ui.ts";

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
    name: "named_auth_fixture",
    label: "Synthetic saved connection",
    description:
      "Exercise saved Linear connections with synthetic user input in an isolated test store.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("add-work"),
        Type.Literal("add-personal"),
        Type.Literal("switch-work"),
        Type.Literal("switch-personal"),
        Type.Literal("remove-personal"),
        Type.Literal("default-work"),
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("logout"),
        Type.Literal("browser"),
        Type.Literal("selection"),
      ]),
    }),
    async execute(_id, input, _signal, _update, context) {
      if (!handler) throw new Error("Auth command was not registered");
      const custom = context.ui.custom.bind(context.ui);
      const ctx = {
        ...context,
        ui: {
          ...context.ui,
          input: async () =>
            input.action === "add-work"
              ? "Work"
              : input.action === "add-personal"
                ? "Personal"
                : "Browser",
          confirm: async () => true,
          select: async (title: string, labels: string[]) => {
            if (title === "Requested Linear access") return "Read only";
            const wanted = ["switch-personal", "remove-personal"].includes(input.action)
              ? "Personal"
              : "Work";
            return labels.find((label) => label.startsWith(wanted));
          },
          custom: (factory: Parameters<typeof custom>[0], options?: Parameters<typeof custom>[1]) =>
            custom(async (tui, theme, keys, done) => {
              const component = await factory(tui, theme, keys, done);
              if (component instanceof MaskedAuthInput) {
                queueMicrotask(() =>
                  component.handleInput(
                    input.action === "add-work" ? "synthetic-work-key" : "synthetic-personal-key",
                  ),
                );
                setTimeout(() => component.handleInput("\r"), 200);
              }
              return component;
            }, options),
        },
      } as unknown as ExtensionCommandContext;
      const command =
        input.action === "remove-personal"
          ? "remove"
          : input.action.startsWith("add-")
            ? "key"
            : input.action.startsWith("switch-")
              ? "switch"
              : input.action === "default-work"
                ? "default"
                : input.action === "browser"
                  ? "user"
                  : input.action;
      if (input.action !== "selection") await handler(command, ctx);
      const selected = context.sessionManager
        .getEntries()
        .findLast(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "linear-connection" &&
            (entry.data as { sessionId?: string } | undefined)?.sessionId ===
              context.sessionManager.getSessionId(),
        );
      const data = selected?.type === "custom" ? selected.data : null;
      return {
        content: [
          { type: "text", text: JSON.stringify({ completed: input.action, selection: data }) },
        ],
        details: { action: input.action, selection: data },
      };
    },
  });
}
