import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IDE_PRESENTATION_CHANGED } from "#src/composite/live-presentation.js";

/** Drive the actual command and settings panel in a real Pi terminal. */
export default async function liveSettingsProbe(pi: ExtensionAPI): Promise<void> {
  const source = process.env.IDE_LIVE_SETTINGS_SOURCE;
  const output = process.env.IDE_LIVE_SETTINGS_PROBE;
  if (!source || !output) throw new Error("Missing settings probe paths");
  const events: unknown[] = [];
  pi.events.on(IDE_PRESENTATION_CHANGED, (event) => events.push(event));
  const entry = (await import(pathToFileURL(source).href)) as {
    default: (api: ExtensionAPI) => Promise<void>;
  };
  await entry.default({
    ...pi,
    registerCommand(name, command) {
      if (name !== "agent-ide-settings") return pi.registerCommand(name, command);
      pi.registerCommand(name, {
        ...command,
        async handler(args, ctx) {
          const statuses: (string | undefined)[] = [];
          const confirms: boolean[] = [];
          const frames: string[][] = [];
          const snapshots: unknown[] = [];
          const timers: ReturnType<typeof setTimeout>[] = [];
          let iteration = 0;
          const key = (value: string, ms: number) => {
            timers.push(setTimeout(() => process.stdin.emit("data", value), ms));
          };
          try {
            for (iteration = 0; iteration < 8; iteration++) {
              await command.handler(args, {
                ...ctx,
                ui: {
                  ...ctx.ui,
                  async select(title, options) {
                    key("\r", 150);
                    return ctx.ui.select(title, options);
                  },
                  async confirm(title, message) {
                    if (iteration === 6) {
                      key("\x1b[B", 150);
                      key("\r", 300);
                    } else key(iteration === 7 ? "\r" : "\x1b", 150);
                    const result = await ctx.ui.confirm(title, message);
                    confirms.push(result);
                    return result;
                  },
                  setStatus(id, text) {
                    if (id === "pi-agent-ide-reload") statuses.push(text);
                    ctx.ui.setStatus(id, text);
                  },
                  custom(factory, options) {
                    return ctx.ui.custom(async (tui, theme, keys, done) => {
                      const component = await factory(tui, theme, keys, done);
                      let driven = false;
                      return {
                        invalidate: () => component.invalidate(),
                        handleInput: (data) => component.handleInput?.(data),
                        render(width) {
                          const rows = component.render(width);
                          frames.push(rows);
                          if (!driven) {
                            driven = true;
                            const inputs = iteration === 0
                              ? ["\t", "\t", "\x1b[B", "\x1b[B", "\r", "\r", "\x13"]
                              : iteration === 1 ? ["\r", "\r", "\x13"]
                              : iteration === 2 ? ["\r", "\x13"]
                              : iteration === 3 ? ["\r", "\r", "\t", "\t", "\x1b[B", "\x1b[B", "\r", "\r", "\x13"]
                              : iteration === 4 ? ["\r", "\x13"]
                              : iteration === 5 ? ["\t", ...Array<string>(7).fill("\x1b[B"), "\r", "\r", "\x13"]
                              : ["\t", "\t", "\x1b[B", "\x1b[B", "\r", "\x1b"];
                            inputs.forEach((input, index) => key(input, 120 * (index + 1)));
                          }
                          return rows;
                        },
                      };
                    }, options);
                  },
                },
              });
              snapshots.push(JSON.parse(await readFile(path.join(ctx.cwd, ".pi/pi-agent-ide/extensions.json"), "utf8")));
            }
          } finally {
            timers.forEach(clearTimeout);
          }
          await writeFile(output, JSON.stringify({ events, statuses, confirms, frames, snapshots }));
          pi.sendUserMessage("Settings inspection complete");
        },
      });
    },
  });
}
