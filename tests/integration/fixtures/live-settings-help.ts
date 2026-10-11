import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { registerSettingsHelp } from "#src/composite/settings-help.js";

/** Internal live viewport probe. Load only alongside the task's feature IDE. */
export default function liveSettingsHelp(pi: ExtensionAPI): void {
  let handler: RegisteredCommand["handler"] | undefined;
  registerSettingsHelp({
    registerCommand: (_name, command) => {
      handler = command.handler;
    },
  });
  let pending: Promise<void> | undefined;
  pi.registerTool({
    name: "settings_help_live",
    label: "Live settings help",
    description:
      "Internal LPT-675 viewport check: open the actual help handler, scroll or close it through native keys. No model turn or setting change.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("open"),
        Type.Literal("end"),
        Type.Literal("home"),
        Type.Literal("close"),
      ]),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      if (handler === undefined || ctx.mode !== "tui") throw new Error("Help is unavailable");
      if (args.action === "open") {
        if (pending !== undefined) throw new Error("Help is already open");
        pending = handler("", ctx as ExtensionCommandContext).finally(() => {
          pending = undefined;
        });
      } else {
        if (pending === undefined) throw new Error("Help is not open");
        process.stdin.emit(
          "data",
          args.action === "end" ? "\x1b[F" : args.action === "home" ? "\x1b[H" : "\x1b",
        );
      }
      await delay(100);
      return {
        content: [
          {
            type: "text",
            text: `Help ${pending === undefined ? "closed" : "open"}; action=${args.action}`,
          },
        ],
        details: undefined,
      };
    },
  });
}
