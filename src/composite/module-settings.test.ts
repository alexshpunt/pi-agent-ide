import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createAgentIdeSettingsRegistry } from "./settings-registry.js";
import { registerAgentIdeSettings, readAgentIdeSetting } from "#src/api/settings.js";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, onTestFinished, test, vi } from "vitest";
import { registerModuleSettings } from "./module-settings.js";
import { AGENT_IDE_PREFERENCES } from "./preferences.js";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark", false);

test.each([
  ["Project", false],
  ["Project", true],
  ["Global", false],
  ["Global", true],
] as const)(
  "Codemode menu preserves unrelated %s preferences when save is %s",
  async (scope, save) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-codemode-menu-"));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    const agentDirectory = path.join(cwd, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const file =
      scope === "Project"
        ? path.join(cwd, ".pi/pi-agent-ide/extensions.json")
        : path.join(agentDirectory, "pi-agent-ide/extensions.json");
    const original = {
      disabled: ["ide.vision"],
      preferences: { future: "keep", "ui.read": "disabled" },
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(original));
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    registerModuleSettings(
      {
        registerCommand: (_name, command) => {
          handler = command.handler;
        },
      },
      [],
      AGENT_IDE_PREFERENCES,
    );
    const custom: ExtensionCommandContext["ui"]["custom"] = async (factory) => {
      return new Promise((resolve, reject) => {
        const invoke = async () => {
          const panel = await factory(
            { requestRender() {} } as Parameters<typeof factory>[0],
            {} as Parameters<typeof factory>[1],
            {} as Parameters<typeof factory>[2],
            resolve,
          );
          panel.handleInput?.("\t");
          panel.handleInput?.("\t");
          panel.handleInput?.("Codemode");
          panel.handleInput?.("\r");
          panel.handleInput?.("\r");
          panel.handleInput?.(save ? "\x13" : "\x1b");
        };
        void invoke().catch(reject);
      });
    };
    const confirm = vi.fn().mockResolvedValue(false);
    const reload = vi.fn();
    const ui: Partial<ExtensionCommandContext["ui"]> = {
      select: vi.fn().mockResolvedValue(scope),
      confirm,
      notify: vi.fn(),
      custom,
    };
    const context: Partial<ExtensionCommandContext> = {
      cwd,
      hasUI: true,
      ui: ui as ExtensionCommandContext["ui"],
      reload,
    };
    await handler?.("", context as ExtensionCommandContext);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(
      save
        ? {
            ...original,
            enabled: [],
            preferences: { ...original.preferences, "ui.codemode": "on" },
          }
        : original,
    );
    expect(confirm).toHaveBeenCalledTimes(save ? 1 : 0);
    expect(reload).not.toHaveBeenCalled();
  },
);

test.each(["Project", "Global"] as const)(
  "semantic engine can be selected in %s settings",
  async (scope) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-semantic-menu-"));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    const agentDirectory = path.join(cwd, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const file =
      scope === "Project"
        ? path.join(cwd, ".pi/pi-agent-ide/extensions.json")
        : path.join(agentDirectory, "pi-agent-ide/extensions.json");
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    registerModuleSettings(
      {
        registerCommand: (_name, command) => {
          handler = command.handler;
        },
      },
      [],
      AGENT_IDE_PREFERENCES,
    );
    const custom: ExtensionCommandContext["ui"]["custom"] = async (factory) =>
      new Promise((resolve, reject) => {
        const invoke = async () => {
          const panel = await factory(
            { requestRender() {} } as Parameters<typeof factory>[0],
            {} as Parameters<typeof factory>[1],
            {} as Parameters<typeof factory>[2],
            resolve,
          );
          panel.handleInput?.("\t");
          panel.handleInput?.("\x1b[B");
          panel.handleInput?.("\r");
          panel.handleInput?.("\r");
          panel.handleInput?.("\x13");
        };
        void invoke().catch(reject);
      });
    const ui: Partial<ExtensionCommandContext["ui"]> = {
      select: vi.fn().mockResolvedValue(scope),
      confirm: vi.fn().mockResolvedValue(false),
      notify: vi.fn(),
      custom,
    };
    await handler?.("", { cwd, hasUI: true, ui } as ExtensionCommandContext);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      preferences: { "search.semantic.engine": "vera" },
    });
  },
);
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

test("external settings registered after command creation save through the existing menu", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "external-settings-menu-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const emitter = new EventEmitter();
  const pi: Pick<ExtensionAPI, "events" | "on" | "registerCommand"> = {
    events: {
      emit(name: string, data: unknown) {
        emitter.emit(name, data);
      },
      on(name: string, listener: (data: unknown) => void) {
        emitter.on(name, listener);
        return () => {
          emitter.off(name, listener);
        };
      },
    },
    on: vi.fn(),
    registerCommand(_name, command) {
      handler = command.handler;
    },
  };
  const registry = createAgentIdeSettingsRegistry(pi, [], []);
  registerModuleSettings(pi, registry.flags, registry.preferences);
  registerAgentIdeSettings(pi, "fixture", [
    {
      kind: "boolean",
      id: "external.toggle",
      name: "Fixture toggle",
      description: "Toggle fixture behavior",
      default: false,
    },
  ]);
  const custom: ExtensionCommandContext["ui"]["custom"] = async (factory) =>
    new Promise((resolve, reject) => {
      void Promise.resolve(
        factory(
          { requestRender() {} } as Parameters<typeof factory>[0],
          {} as Parameters<typeof factory>[1],
          {} as Parameters<typeof factory>[2],
          resolve,
        ),
      )
        .then((panel) => {
          panel.handleInput?.("\t");
          panel.handleInput?.("Fixture toggle");
          panel.handleInput?.("\r");
          panel.handleInput?.("\r");
          panel.handleInput?.("\x13");
        })
        .catch(reject);
    });
  const ui: Partial<ExtensionCommandContext["ui"]> = {
    select: vi.fn().mockResolvedValue("Project"),
    custom,
    confirm: async () => false,
    notify() {},
  };
  const context: Partial<ExtensionCommandContext> = {
    cwd,
    hasUI: true,
    ui: ui as ExtensionCommandContext["ui"],
  };
  await handler?.("", context as ExtensionCommandContext);
  const saved = JSON.parse(
    await readFile(path.join(cwd, ".pi", "pi-agent-ide", "extensions.json"), "utf8"),
  ) as { flags: Record<string, boolean> };
  expect(saved.flags).toEqual({ "external.toggle": true });
  expect(await readAgentIdeSetting(pi.events, "external.toggle", cwd)).toEqual({
    value: true,
    overridden: true,
  });
});
