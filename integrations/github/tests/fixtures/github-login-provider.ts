import path from "node:path";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GithubConnections } from "#github/connections/manager.ts";
import { GithubConnectionStore } from "#github/connections/store.ts";
import { registerGithubAuthCommands } from "#github/connections/commands.ts";
import { GithubRequestCoordinator } from "#github/request-coordinator.ts";

export default async function githubLoginFixture(pi: ExtensionAPI): Promise<void> {
  let handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
  const store = new GithubConnectionStore(path.join(process.cwd(), ".connections"));
  const coordinator = new GithubRequestCoordinator({ directory: null, mutationIntervalMs: 0 });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://github.com/login/device/code") {
      if (new URLSearchParams(String(init?.body)).get("client_id") !== "fixture-client-id") throw new Error("Unexpected fixture client ID");
      return Response.json({ device_code: "fixture-private-device", user_code: "PIAA-TEST", verification_uri: "https://github.com/login/device", expires_in: 600, interval: 1 });
    }
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ token_type: "bearer", access_token: "fixture-private-access", expires_in: 3600, refresh_token: "fixture-private-refresh", refresh_token_expires_in: 86400 });
    if (url === "https://api.github.com/user" && new Headers(init?.headers).get("authorization") === "Bearer fixture-private-access") return Response.json({ id: 42, login: "fixture-user", name: "Fixture user" });
    throw new Error("Fixture blocked unexpected network request");
  };
  const connections = new GithubConnections({ store, coordinator, fetcher, legacyConfig: async () => undefined });
  let footerWrites = 0;
  const monitorStatus = <T extends ExtensionContext>(context: T): T => ({
    ...context,
    ui: {
      ...context.ui,
      setStatus(key: string, value: string | undefined) {
        if (key === "github" && value !== undefined) footerWrites++;
        context.ui.setStatus(key, value);
      },
    },
  });
  registerGithubAuthCommands(new Proxy(pi, {
    get(target, name) {
      if (name === "registerCommand") return (command: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
        if (command === "github") handler = definition.handler;
        return target.registerCommand(command, definition);
      };
      if (name === "on") return (event: string, listener: (event: unknown, context: ExtensionContext) => unknown) => {
        const on = target.on.bind(target) as unknown as (event: string, listener: (event: unknown, context: ExtensionContext) => unknown) => unknown;
        return on(event, (data, context) => listener(data, monitorStatus(context)));
      };
      return Reflect.get(target, name);
    },
  }), connections, { fetcher, coordinator });
  pi.on("session_shutdown", () => connections.dispose());
  pi.registerTool({
    name: "github_login_fixture", label: "Synthetic GitHub sign-in", description: "Exercise the real GitHub command with synthetic sign-in inputs.",
    parameters: Type.Object({ cancel: Type.Boolean(), scenario: Type.Optional(Type.Union([Type.Literal("switch"), Type.Literal("global"), Type.Literal("logout")])) }),
    async execute(_id, input, _signal, _update, context) {
      if (!handler) throw new Error("GitHub command was not registered");
      if (input.scenario) {
        for (const id of ["a", "b"]) {
          await store.saveProfile({ id, kind: "pat", label: `fixture-account-${id}` }, { kind: "pat", token: `fixture-private-${id}` });
        }
        await store.setProjectDefault(context.cwd, "a");
        connections.useProfile("a");
      }
      const custom = context.ui.custom.bind(context.ui);
      const select = context.ui.select.bind(context.ui);
      const confirm = context.ui.confirm.bind(context.ui);
      const textInput = context.ui.input.bind(context.ui);
      // Drive Pi's real stdin parser, selectors and confirmation dialog.
      const keys = (...sequence: string[]) => {
        sequence.forEach((key, index) => setTimeout(() => process.stdin.emit("data", Buffer.from(key)), 200 + index * 100));
      };
      let loginStep = 0;
      let inputStep = 0;
      let scenarioStep = 0;
      const menuSizes: number[] = [];
      const monitored = monitorStatus(context);
      const commandContext = {
        ...monitored,
        ui: {
          ...monitored.ui,
          select: (title: string, options: string[], opts?: Parameters<typeof select>[2]) => {
            if (input.scenario) {
              menuSizes.push(options.length);
              if (scenarioStep === 0) {
                if (input.scenario !== "logout") keys("\x1b[B", "\x1b[B", "\r");
                else keys("\x1b[B", "\r");
              } else if (input.scenario !== "logout" && scenarioStep === 1) {
                if (input.scenario === "global") keys("\r"); else keys("\x1b[B", "\r");
              } else if ((input.scenario !== "logout" && scenarioStep === 2) || (input.scenario === "logout" && scenarioStep === 1)) {
                const index = options.findIndex(option => option.includes("fixture-account-b"));
                if (index < 0) throw new Error("Expected synthetic account was not offered");
                keys(...Array.from({ length: index }, () => "\x1b[B"), "\r");
              }
              else keys("\x1b");
              scenarioStep++;
            } else {
              if (loginStep === 0 || loginStep === 2) keys("\r");
              else if (loginStep === 1) keys("\x1b[B", "\r");
              else keys("\x1b");
              loginStep++;
            }
            return select(title, options, opts);
          },
          confirm: (title: string, message: string, opts?: Parameters<typeof confirm>[2]) => {
            if (input.scenario === "logout") keys("\r");
            return confirm(title, message, opts);
          },
          input: (title: string, placeholder?: string, opts?: Parameters<typeof textInput>[2]) => {
            if (inputStep++ === 0) keys("fixture-client-id", "\r");
            else keys("Synthetic account", "\r");
            return textInput(title, placeholder, opts);
          },
          custom: (factory: Parameters<typeof custom>[0], options?: Parameters<typeof custom>[1]) =>
            custom(async (tui, theme, keys, done) => {
              const component = await factory(tui, theme, keys, done);
              const Dialog = (Pi as unknown as { LoginDialogComponent?: new (...args: never[]) => object }).LoginDialogComponent;
              if (!Dialog || !(component instanceof Dialog)) throw new Error("Native Pi LoginDialogComponent was not used");
              if (input.cancel) setTimeout(() => process.stdin.emit("data", Buffer.from("\x1b")), 500);
              return component;
            }, options),
        },
      } as unknown as ExtensionCommandContext;
      await handler("", commandContext);
      const credentials = input.scenario ? JSON.parse(await readFile(path.join(process.cwd(), ".connections", "credentials.json"), "utf8")) as { secrets: Record<string, unknown> } : undefined;
      let newSession: string | undefined;
      if (input.scenario === "global") {
        const next = new GithubConnections({ store, coordinator, fetcher, legacyConfig: async () => undefined });
        try { newSession = (await next.capture(context.cwd)).profile.id; } finally { next.dispose(); }
      }
      const result = input.scenario ? {
        menuSizes, current: connections.sessionProfile, projectDefault: await store.getProjectDefault(context.cwd),
        profiles: (await store.listProfiles()).map(profile => profile.id),
        credentialIds: Object.keys(credentials!.secrets).sort(), footerWrites,
        ...(input.scenario === "global" ? { globalDefault: await store.getGlobalDefault(), newSession } : {}),
      } : {};
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });
}
