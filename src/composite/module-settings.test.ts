import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, onTestFinished, test, vi } from "vitest";
import { registerModuleSettings } from "./module-settings.js";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark", false);

function customDialog(save: boolean): ExtensionCommandContext["ui"]["custom"] {
  return async (factory) => {
    return new Promise((resolve, reject) => {
      const invoke = async () => {
        const panel = await factory(
          { requestRender() {} } as Parameters<typeof factory>[0],
          {} as Parameters<typeof factory>[1],
          {} as Parameters<typeof factory>[2],
          resolve,
        );
        panel.handleInput?.("\r");
        panel.handleInput?.("\r");
        panel.handleInput?.(save ? "\x13" : "\x1b");
      };
      void invoke().catch(reject);
    });
  };
}

test("canceling staged module choices leaves project settings absent", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-menu-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi: Pick<ExtensionAPI, "registerCommand"> = {
    registerCommand: (_name: string, command: { handler: typeof handler }) => {
      handler = command.handler;
    },
  };
  registerModuleSettings(pi);
  const select = vi
    .fn()
    .mockImplementationOnce((_title: string, options: string[]) => options[0])
    .mockImplementationOnce((_title: string, options: string[]) => options[2])
    .mockImplementationOnce((_title: string, options: string[]) => options[1])
    .mockResolvedValueOnce(undefined);
  const reload = vi.fn();
  const notify = vi.fn();
  const ui: Partial<ExtensionCommandContext["ui"]> = {
    select,
    notify,
    custom: customDialog(false),
  };
  const context: Partial<ExtensionCommandContext> = {
    cwd,
    hasUI: true,
    ui: ui as ExtensionCommandContext["ui"],
    reload,
  };
  await handler?.("", context as ExtensionCommandContext);
  expect(select).toHaveBeenCalledTimes(1);
  expect(notify).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  await expect(readFile(path.join(cwd, ".pi/pi-agent-ide/extensions.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test.each([false, true])(
  "saving a project override reloads only after confirmation: %s",
  async (confirmed) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-menu-"));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    registerModuleSettings({
      registerCommand: (_name, command) => {
        handler = command.handler;
      },
    });
    const select = vi
      .fn()
      .mockImplementationOnce((_title: string, options: string[]) => options[0])
      .mockImplementationOnce((_title: string, options: string[]) => options[2])
      .mockImplementationOnce((_title: string, options: string[]) => options[1])
      .mockImplementationOnce((_title: string, options: string[]) => options[0]);
    const reload = vi.fn();
    const confirm = vi.fn().mockResolvedValue(confirmed);
    const ui: Partial<ExtensionCommandContext["ui"]> = {
      select,
      confirm,
      notify: vi.fn(),
      custom: customDialog(true),
    };
    const context: Partial<ExtensionCommandContext> = {
      cwd,
      hasUI: true,
      ui: ui as ExtensionCommandContext["ui"],
      reload,
    };
    await handler?.("", context as ExtensionCommandContext);
    expect(
      JSON.parse(await readFile(path.join(cwd, ".pi/pi-agent-ide/extensions.json"), "utf8")),
    ).toMatchObject({ disabled: ["ide.core"] });
    expect(confirm).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  },
);
