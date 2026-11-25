import { isolatedCoordinator } from "./fixtures/github-coordinator.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerGithubAuthCommands,
  type GithubCommandContext,
  type GithubCommandRegistry,
} from "#github/connections/commands.ts";
import { GithubConnections } from "#github/connections/manager.ts";
import { MemoryStore } from "./fixtures/memory-connections.ts";

type Handler = Parameters<GithubCommandRegistry["registerCommand"]>[1]["handler"];
type SessionHook = Parameters<GithubCommandRegistry["on"]>[1];
const open: GithubConnections[] = [];
afterEach(() => {
  for (const connections of open.splice(0)) connections.dispose();
});
async function setup(seed = true, transport?: typeof fetch, coordinator = isolatedCoordinator()) {
  const store = new MemoryStore();
  if (seed) {
    for (const id of ["a", "b"])
      await store.saveProfile(
        { id, kind: "pat", label: id },
        { kind: "pat", token: `fixture-${id}` },
      );
    await store.setProjectDefault("/project", "a");
  }
  const fetcher: typeof fetch =
    transport ?? (async () => Response.json({ id: 42, login: "someone", name: "Fixture user" }));
  const connections = new GithubConnections({
    coordinator,
    store,
    fetcher,
    legacyConfig: async () => undefined,
  });
  open.push(connections);
  const hooks = new Map<string, SessionHook>();
  const entries: { customType: string; data: unknown }[] = [];
  let handler!: Handler;
  let commandName = "";
  const pi: GithubCommandRegistry = {
    registerCommand(name: string, definition: { handler: Handler }) {
      commandName = name;
      handler = definition.handler;
    },
    on(name, callback) {
      hooks.set(name, callback);
      return () => {
        hooks.delete(name);
      };
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  };
  const notifications: string[] = [];
  const statuses: string[] = [];
  const context: GithubCommandContext = {
    cwd: "/project",
    signal: undefined,
    mode: "print",
    hasUI: false,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify(value: string) {
        notifications.push(value);
      },
      async confirm() {
        throw new Error("Unexpected confirmation");
      },
      async custom() {
        throw new Error("Unexpected custom UI");
      },
      async input() {
        throw new Error("Unexpected input");
      },
      async select() {
        throw new Error("Unexpected selection");
      },
    },
  };
  Object.assign(context.ui, {
    setStatus(_key: string, value: string | undefined) {
      if (value) statuses.push(value);
    },
  });
  registerGithubAuthCommands(pi, connections, { fetcher });
  return {
    store,
    connections,
    hooks,
    entries,
    context,
    notifications,
    statuses,
    commandName,
    invoke: (args: string) => handler(args, context),
  };
}

describe("GitHub connection commands", () => {
  it("registers one GitHub connection command", async () => {
    const fixture = await setup();
    expect(fixture.commandName).toBe("github");
  });

  it("shows the public cooldown deadline and repeated status sends no further HTTP", async () => {
    const now = Date.now();
    const resetAt = (Math.ceil(now / 1000) + 120) * 1000;
    const fetcher = vi.fn(
      async () =>
        new Response("{}", {
          status: 429,
          headers: {
            "retry-after": "60",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetAt / 1000),
          },
        }),
    );
    const fixture = await setup(
      true,
      fetcher,
      isolatedCoordinator(() => now),
    );
    await fixture.invoke("status");
    await fixture.invoke("status");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fixture.notifications).toHaveLength(2);
    for (const notification of fixture.notifications) {
      expect(notification).toContain(new Date(resetAt).toISOString());
      expect(notification).not.toContain("fixture-a");
    }
  });
  it("persists only a non-secret session profile reference when switching", async () => {
    const fixture = await setup();
    await fixture.invoke("use b");
    expect(fixture.connections.sessionProfile).toBe("b");
    expect(fixture.entries).toEqual([
      { customType: "pi-agent-github-profile", data: { profileId: "b" } },
    ]);
    expect(JSON.stringify(fixture.entries)).not.toContain("fixture-");
    expect(await fixture.store.getProjectDefault("/project")).toBe("a");
  });

  it("restores the active branch's profile and retires the previous selection", async () => {
    const fixture = await setup();
    const before = await fixture.connections.capture("/project");
    const context = {
      ...fixture.context,
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: "pi-agent-github-profile", data: { profileId: "a" } },
          { type: "custom", customType: "pi-agent-github-profile", data: { profileId: "b" } },
        ],
      },
    } satisfies GithubCommandContext;
    const hook = fixture.hooks.get("session_tree");
    if (!hook) throw new Error("Expected a session_tree hook");
    await hook({}, context);
    expect(fixture.connections.sessionProfile).toBe("b");
    expect(() => before.assertCurrent()).toThrow("GH_CONNECTION_CHANGED");
  });

  it("never echoes transport or store error contents", async () => {
    const fixture = await setup();
    vi.spyOn(fixture.store, "getProfile").mockRejectedValue(
      new Error("canary-private-error-value"),
    );
    await fixture.invoke("use b");
    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0]).toContain("authorization failed");
    expect(fixture.notifications[0]).not.toContain("canary-private-error-value");
  });

  it("the account menu switches only this session and returns to the menu", async () => {
    const fixture = await setup();
    const steps = [2, 1, 1];
    const optionCounts: number[] = [];
    let menus = 0;
    Object.assign(fixture.context, { hasUI: true });
    Object.assign(fixture.context.ui, {
      select: async (_title: string, items: string[]) => {
        menus++;
        optionCounts.push(items.length);
        const index = steps.shift();
        return index === undefined ? undefined : items[index];
      },
    });
    await fixture.invoke("");
    expect(fixture.connections.sessionProfile).toBe("b");
    expect(await fixture.store.getProjectDefault("/project")).toBe("a");
    expect(menus).toBe(4);
    expect(optionCounts.slice(0, 2)).toEqual([3, 2]);
    expect(fixture.statuses).toEqual([]);
  });
  it("session startup does not show a GitHub footer status", async () => {
    const fixture = await setup();
    Object.assign(fixture.context, { hasUI: true });
    const hook = fixture.hooks.get("session_start");
    if (!hook) throw new Error("Expected a session_start hook");
    await hook({}, fixture.context);
    expect(fixture.statuses).toEqual([]);
  });
  it("sets a global default for new sessions without changing this session", async () => {
    const fixture = await setup();
    await fixture.invoke("switch a");
    await fixture.invoke("global b");
    expect(await fixture.store.getGlobalDefault()).toBe("b");
    expect(fixture.connections.sessionProfile).toBe("a");
  });
  it("can clear the global default without changing the current session", async () => {
    const fixture = await setup();
    await fixture.store.setGlobalDefault("b");
    await fixture.invoke("switch a");
    await fixture.invoke("clear-global");
    expect(await fixture.store.getGlobalDefault()).toBeUndefined();
    expect(fixture.connections.sessionProfile).toBe("a");
  });
  it("can clear a project default without changing the current session", async () => {
    const fixture = await setup();
    await fixture.invoke("switch a");
    await fixture.invoke("clear-project");
    expect(await fixture.store.getProjectDefault("/project")).toBeUndefined();
    expect(fixture.connections.sessionProfile).toBe("a");
  });
  it("changing a project default does not change this session's selection", async () => {
    const fixture = await setup();
    await fixture.invoke("switch a");
    await fixture.invoke("default b");
    expect(await fixture.store.getProjectDefault("/project")).toBe("b");
    expect(fixture.connections.sessionProfile).toBe("a");
  });
  it("switch explicitly selects a saved connection without changing the project default", async () => {
    const fixture = await setup();
    const old = await fixture.connections.capture("/project");
    await fixture.invoke("switch b");
    expect(fixture.connections.sessionProfile).toBe("b");
    expect((await fixture.connections.capture("/project")).profile.id).toBe("b");
    expect(await fixture.store.getProjectDefault("/project")).toBe("a");
    expect(() => old.assertCurrent()).toThrow("GH_CONNECTION_CHANGED");
    expect(fixture.notifications.join("\n")).toContain("Switched to");
  });

  it.each(["logout", "remove"])(
    "%s of an inactive connection leaves current access and credentials intact",
    async (action) => {
      const fixture = await setup();
      const current = await fixture.connections.capture("/project");
      Object.assign(fixture.context, { hasUI: true });
      Object.assign(fixture.context.ui, { confirm: async () => true });
      await fixture.invoke(`${action} b`);
      expect(await fixture.store.getProfile("b")).toBeUndefined();
      expect(fixture.store.secrets.has("b")).toBe(false);
      expect(await fixture.store.getProfile("a")).toBeDefined();
      expect(fixture.store.secrets.get("a")).toEqual({ kind: "pat", token: "fixture-a" });
      expect(await fixture.connections.capture("/project")).toBe(current);
      expect(() => current.assertCurrent()).not.toThrow();
      expect(fixture.notifications.join("\n")).toContain("Removed local connection");
    },
  );

  it("logout removes the active connection without falling back to another default", async () => {
    const fixture = await setup();
    await fixture.invoke("use a");
    await fixture.store.setProjectDefault("/project", "b");
    const current = await fixture.connections.capture("/project");
    Object.assign(fixture.context, { hasUI: true });
    Object.assign(fixture.context.ui, { confirm: async () => true });
    await fixture.invoke("logout a");
    expect(await fixture.store.getProfile("a")).toBeUndefined();
    expect(fixture.store.secrets.has("a")).toBe(false);
    expect(fixture.store.secrets.get("b")).toEqual({ kind: "pat", token: "fixture-b" });
    expect(() => current.assertCurrent()).toThrow("GH_CONNECTION_CHANGED");
    await expect(fixture.connections.capture("/project")).rejects.toThrow("GH_CONNECTION_MISSING");
    await fixture.invoke("switch b");
    expect((await fixture.connections.capture("/project")).profile.id).toBe("b");
  });

  it("explains that a removed PAT must be revoked on GitHub separately", async () => {
    const fixture = await setup();
    Object.assign(fixture.context, { hasUI: true });
    Object.assign(fixture.context.ui, { confirm: async () => true });
    await fixture.invoke("logout b");
    expect(fixture.notifications.join("\n")).toMatch(/revoke.*GitHub/i);
    expect(fixture.notifications.join("\n")).not.toContain("fixture-b");
  });
  it.each(["revoked", "refused", "unknown", "not-sent", "not-cached"] as const)(
    "reports App token revocation outcome %s separately from local removal",
    async (outcome) => {
      const fixture = await setup();
      await fixture.store.saveProfile({
        id: "bot",
        kind: "app",
        label: "Bot",
        appId: 1,
        installationId: 2,
        privateKeyPath: "/tmp/synthetic-key.pem",
      });
      const revoke = vi
        .spyOn(fixture.connections, "revokeCachedInstallationToken")
        .mockResolvedValue(outcome);
      Object.assign(fixture.context, { hasUI: true });
      Object.assign(fixture.context.ui, { confirm: async () => true });
      await fixture.invoke("logout bot");
      expect(revoke).toHaveBeenCalledOnce();
      expect(await fixture.store.getProfile("bot")).toBeUndefined();
      const output = fixture.notifications.join("\n");
      expect(output).toContain("Removed local connection");
      expect(output).toContain(
        (
          {
            revoked: "revoked",
            refused: "refused",
            unknown: "unknown",
            "not-sent": "not sent",
            "not-cached": "no cached",
          } as const
        )[outcome],
      );
      expect(output).toContain("installation");
    },
  );
  it.each(["fixture-replacement", "fixture-a"])(
    "logout does not delete a concurrently replaced credential, even when its value matches",
    async (replacement) => {
      const fixture = await setup();
      Object.assign(fixture.context, { hasUI: true });
      Object.assign(fixture.context.ui, {
        confirm: async () => {
          await fixture.store.saveProfile(
            { id: "a", kind: "pat", label: "a" },
            { kind: "pat", token: replacement },
          );
          return true;
        },
      });
      await fixture.invoke("logout a");
      expect(await fixture.store.getProfile("a")).toBeDefined();
      expect(fixture.store.secrets.get("a")).toEqual({ kind: "pat", token: replacement });
      expect(fixture.notifications.join("\n")).toMatch(/changed|replaced/i);
    },
  );
  it("protects a replacement made while the logout selection menu is open", async () => {
    const fixture = await setup();
    Object.assign(fixture.context, { hasUI: true });
    Object.assign(fixture.context.ui, {
      select: async (_title: string, choices: string[]) => {
        await fixture.store.saveProfile(
          { id: "a", kind: "pat", label: "a" },
          { kind: "pat", token: "fixture-new" },
        );
        return choices[0];
      },
      confirm: async () => true,
    });
    await fixture.invoke("logout");
    expect(fixture.store.secrets.get("a")).toEqual({ kind: "pat", token: "fixture-new" });
    expect(fixture.notifications.join("\n")).toMatch(/changed|replaced/i);
  });
  it("reports the remote outcome but preserves a replacement made during App token revocation", async () => {
    const fixture = await setup();
    const bot = {
      id: "bot",
      kind: "app" as const,
      label: "Bot",
      appId: 1,
      installationId: 2,
      privateKeyPath: "/tmp/synthetic-key.pem",
    };
    await fixture.store.saveProfile(bot);
    vi.spyOn(fixture.connections, "revokeCachedInstallationToken").mockImplementation(async () => {
      await fixture.store.saveProfile(bot);
      return "revoked";
    });
    Object.assign(fixture.context, { hasUI: true });
    Object.assign(fixture.context.ui, { confirm: async () => true });
    await fixture.invoke("logout bot");
    expect(await fixture.store.getProfile("bot")).toBeDefined();
    expect(fixture.notifications.join("\n")).toContain("revoked");
    expect(fixture.notifications.join("\n")).toMatch(/changed|replaced/i);
    expect(fixture.notifications.join("\n")).not.toContain("Removed local connection");
  });
  it("reports an unconfirmed local removal separately from a confirmed remote revocation", async () => {
    const fixture = await setup();
    await fixture.store.saveProfile({
      id: "bot",
      kind: "app",
      label: "Bot",
      appId: 1,
      installationId: 2,
      privateKeyPath: "/tmp/synthetic-key.pem",
    });
    vi.spyOn(fixture.connections, "revokeCachedInstallationToken").mockResolvedValue("revoked");
    vi.spyOn(fixture.store, "removeProfileIfUnchanged").mockRejectedValue(
      new Error("secret error must not be printed"),
    );
    Object.assign(fixture.context, { hasUI: true });
    Object.assign(fixture.context.ui, { confirm: async () => true });
    await fixture.invoke("logout bot");
    const output = fixture.notifications.join("\n");
    expect(output).toContain("could not be confirmed");
    expect(output).toContain("was revoked");
    expect(output).not.toContain("secret error");
    expect(output).not.toContain("Removed local connection");
  });
  it("logout cancellation does not delete or switch anything", async () => {
    const fixture = await setup();
    const current = await fixture.connections.capture("/project");
    Object.assign(fixture.context, { hasUI: true });
    Object.assign(fixture.context.ui, { confirm: async () => false });
    await fixture.invoke("logout a");
    expect((await fixture.store.listProfiles()).map((profile) => profile.id)).toEqual(["a", "b"]);
    expect(fixture.store.secrets.size).toBe(2);
    expect(await fixture.connections.capture("/project")).toBe(current);
    expect(fixture.entries).toEqual([]);
  });

  it.each([
    ["GH_AUTH_REQUEST_FAILED", "Could not reach GitHub"],
    [
      "GitHub authorization request failed. No personal credential was used.",
      "Could not reach GitHub",
    ],
    ["GH_AUTH_TIMEOUT", "timed out"],
    ["GH_AUTH_DEVICE_DISABLED", "Enable device flow"],
    ["GH_AUTH_UNAUTHORIZED", "rejected the credential"],
    ["GH_CONNECTION_STORE_UNSAFE", "owner-only"],
  ])("explains safe authentication failure %s", async (code, expected) => {
    const fixture = await setup();
    vi.spyOn(fixture.store, "getProfile").mockRejectedValue(new Error(code));
    await fixture.invoke("status");
    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0]).toContain(expected);
  });
  it.each([true, false])(
    "adding a masked PAT only saves it, including first connection (existing=%s)",
    async (seed) => {
      const fixture = await setup(seed);
      const before = await fixture.store.listProfiles();
      const active = seed ? await fixture.connections.capture("/project") : undefined;
      const canary = "ghp_canary_never_echo_this";
      const rendered: string[] = [];
      type Component = {
        focused?: boolean;
        render(width: number): string[];
        handleInput(data: string): void;
        dispose?(): void;
      };
      type Factory = (
        tui: { requestRender(): void },
        theme: { fg(color: string, value: string): string },
        keys: unknown,
        done: (value: unknown) => void,
      ) => Component | Promise<Component>;
      Object.assign(fixture.context, { hasUI: true, mode: "tui" });
      Object.assign(fixture.context.ui, {
        select: async () => "Personal access token",
        input: async () => "",
        custom: (factory: Factory) =>
          new Promise((resolve, reject) => {
            Promise.resolve(
              factory({ requestRender() {} }, { fg: (_color, value) => value }, {}, resolve),
            ).then((component) => {
              component.focused = true;
              component.handleInput(`\x1b[200~${canary}\x1b[201~`);
              rendered.push(...component.render(60));
              component.handleInput("\r");
              component.dispose?.();
            }, reject);
          }),
      });
      await fixture.invoke("add");
      const added = (await fixture.store.listProfiles()).find(
        (profile) => !before.some((old) => old.id === profile.id),
      );
      expect(added).toMatchObject({ kind: "pat", login: "someone" });
      if (!added) throw new Error("Expected a saved profile");
      expect(fixture.store.secrets.get(added.id)).toEqual({ kind: "pat", token: canary });
      expect(await fixture.store.listProfiles()).toEqual([...before, added]);
      expect(fixture.connections.sessionProfile).toBeUndefined();
      expect(fixture.entries).toEqual([]);
      expect(await fixture.store.getProjectDefault("/project")).toBe(seed ? "a" : undefined);
      if (active) expect(await fixture.connections.capture("/project")).toBe(active);
      else
        await expect(fixture.connections.capture("/project")).rejects.toThrow(
          "GH_CONNECTION_REQUIRED",
        );
      expect(JSON.stringify([...fixture.store.profiles.values()])).not.toContain(canary);
      expect(rendered.join("\n")).not.toContain(canary);
      expect(fixture.notifications.join("\n")).not.toContain(canary);
      expect(JSON.stringify(fixture.entries)).not.toContain(canary);
      expect(fixture.notifications.join("\n")).toContain("Saved connection for someone");
    },
  );
});
