import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listenPresentationPreference } from "#src/composite/live-presentation.ts";
import { moduleLabels } from "#src/composite/module-labels.ts";
import { AGENT_IDE_PREFERENCES } from "#src/composite/preferences.ts";

function preferenceName(id: string): string {
  const preference = AGENT_IDE_PREFERENCES.find((item) => item.id === id);
  if (!preference) throw new Error(`Unknown test preference: ${id}`);
  return preference.name;
}

/** Drive the actual command and settings panel in a real Pi terminal. */
export default async function liveSettingsProbe(pi: ExtensionAPI): Promise<void> {
  const source = process.env.IDE_LIVE_SETTINGS_SOURCE;
  const output = process.env.IDE_LIVE_SETTINGS_PROBE;
  if (!source || !output) throw new Error("Missing settings probe paths");
  const codemode = preferenceName("ui.codemode");
  const semanticEngine = preferenceName("search.semantic.engine");
  const ideServices = moduleLabels["ide.core"][0];
  const appliedCodemode: (string | undefined)[] = [];
  listenPresentationPreference(pi, "ui.codemode", (value) => appliedCodemode.push(value));
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
          const codemodeUpdates: (string | undefined)[][] = [];
          const findCodemode = ["\t", "\t", codemode];
          const save = "\x13";
          const exit = "\x1b";
          // SettingsList filters by label. Resolve labels from IDs instead of counting rows.
          const actions = [
            [...findCodemode, "\r", "\r", save], // Turn Codemode on.
            [ideServices, "\r", "\r", save], // Disable IDE services.
            [ideServices, "\r", save], // Revert to the default.
            [ideServices, "\r", "\r", ...findCodemode, "\r", "\r", save], // Disable services and turn Codemode off.
            [ideServices, "\r", save], // Revert only the module change.
            ["\t", semanticEngine, "\r", "\r", save], // Switch to Vera.
            [...findCodemode, "\r", exit], // Discard the change to Codemode.
            [...findCodemode, "\r", exit], // Confirm the change to Codemode.
          ];
          const timers: ReturnType<typeof setTimeout>[] = [];
          const key = (value: string, ms: number) => {
            timers.push(setTimeout(() => process.stdin.emit("data", value), ms));
          };
          try {
            for (const [iteration, inputs] of actions.entries()) {
              const updatesBefore = appliedCodemode.length;
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
                            inputs.forEach((input, index) => key(input, 120 * (index + 1)));
                          }
                          return rows;
                        },
                      };
                    }, options);
                  },
                },
              });
              codemodeUpdates.push(appliedCodemode.slice(updatesBefore));
              snapshots.push(
                JSON.parse(
                  await readFile(path.join(ctx.cwd, ".pi/pi-agent-ide/extensions.json"), "utf8"),
                ),
              );
            }
          } finally {
            timers.forEach(clearTimeout);
          }
          await writeFile(
            output,
            JSON.stringify({ codemodeUpdates, statuses, confirms, frames, snapshots }),
          );
          pi.sendUserMessage("Settings inspection complete");
        },
      });
    },
  });
}
