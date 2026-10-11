import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Drive the real help command through native input and record its transient effects. */
export default async function settingsHelpProbe(pi: ExtensionAPI): Promise<void> {
  const source = process.env.IDE_SETTINGS_HELP_SOURCE;
  const output = process.env.IDE_SETTINGS_HELP_PROBE;
  if (source === undefined || output === undefined) throw new Error("Missing help probe paths");
  let registered = false;
  let requests = 0;
  pi.on("before_provider_request", () => {
    requests++;
  });
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setTheme(process.env.IDE_SETTINGS_HELP_THEME ?? "dark");
  });
  const entry = (await import(pathToFileURL(source).href)) as {
    default: (api: ExtensionAPI) => Promise<void>;
  };
  await entry.default({
    ...pi,
    registerCommand(name, command) {
      if (name !== "agent-ide-help") {
        pi.registerCommand(name, command);
        return;
      }
      registered = true;
      pi.registerCommand(name, {
        ...command,
        async handler(args, ctx) {
          const before = ctx.sessionManager.getBranch();
          const frames: string[][] = [];
          let driven = false;
          let timedOut = false;
          const timers: ReturnType<typeof setTimeout>[] = [];
          try {
            await command.handler(args, {
              ...ctx,
              ui: {
                ...ctx.ui,
                custom(factory, options) {
                  return ctx.ui.custom(async (tui, theme, keys, done) => {
                    const component = await factory(tui, theme, keys, done);
                    return {
                      invalidate: () => component.invalidate(),
                      handleInput: (data) => component.handleInput?.(data),
                      render(width) {
                        const rows = component.render(width);
                        frames.push(rows);
                        if (!driven) {
                          driven = true;
                          timers.push(setTimeout(() => process.stdin.emit("data", "\x1b[F"), 150));
                          timers.push(setTimeout(() => process.stdin.emit("data", "\x1b[H"), 300));
                          timers.push(setTimeout(() => process.stdin.emit("data", "\x1b"), 450));
                          timers.push(
                            setTimeout(() => {
                              timedOut = true;
                              done(undefined as never);
                            }, 3000),
                          );
                        }
                        return rows;
                      },
                    };
                  }, options);
                },
              },
            });
          } finally {
            timers.forEach(clearTimeout);
          }
          const unchanged =
            JSON.stringify(before) === JSON.stringify(ctx.sessionManager.getBranch());
          process.stdin.emit("data", "restored editor");
          await delay(40);
          const focused = ctx.ui.getEditorText() === "restored editor";
          ctx.ui.setEditorText("");
          await writeFile(
            output,
            JSON.stringify({ registered, frames, timedOut, unchanged, focused, requests }),
          );
          pi.sendUserMessage("Inspection complete");
        },
      });
    },
  });
  if (!registered) {
    pi.registerCommand("agent-ide-help", {
      description: "Report the missing baseline command",
      async handler() {
        await writeFile(output, JSON.stringify({ registered, frames: [], requests }));
        pi.sendUserMessage("Inspection complete");
      },
    });
  }
}
