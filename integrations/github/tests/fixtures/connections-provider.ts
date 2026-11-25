import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGithubProvider } from "#github/index.ts";
import { GithubBackend } from "#github/backend.ts";
import { GithubConnections } from "#github/connections/manager.ts";
import { GithubConnectionStore } from "#github/connections/store.ts";
import { registerGithubAuthCommands } from "#github/connections/commands.ts";

export default async function connectionsFixture(pi: ExtensionAPI, afterSetup?: (connections: GithubConnections) => Promise<void>): Promise<void> {
  const cwd = process.cwd();
  const stateFile = path.join(cwd, "connections-fixture.json");
  const store = new GithubConnectionStore(path.join(cwd, ".connections"));
  const scenario = JSON.parse(await readFile(stateFile, "utf8")) as { authKind?: "pat" | "device" | "app"; privateKeyPath?: string };
  const kind = scenario.authKind ?? "pat";
  for (const id of ["a", "b"]) {
    const base = { id, label: `Connection ${id.toUpperCase()}`, login: kind === "app" ? "fixture-app[bot]" : "same-user" };
    if (kind === "app") {
      if (!scenario.privateKeyPath) throw new Error("Missing synthetic App key reference");
      await store.saveProfile({ ...base, kind, appId: 123, installationId: id === "a" ? 456 : 457, privateKeyPath: scenario.privateKeyPath });
    } else if (kind === "device") {
      await store.saveProfile({ ...base, kind, clientId: "fixture-client-id" }, { kind, accessToken: `fixture-private-${id}`, expiresAt: Date.now() + 1000, refreshToken: `fixture-refresh-${id}`, refreshExpiresAt: Date.now() + 86_400_000 });
    } else await store.saveProfile({ ...base, kind }, { kind, token: `fixture-private-${id}` });
  }
  await store.setProjectDefault(cwd, "a");
  let connections!: GithubConnections;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "https://github.com") {
      const fields = new URLSearchParams(String(init?.body));
      if (fields.get("client_id") !== "fixture-client-id" || fields.has("client_secret")) throw new Error("Unknown fixture App Client ID or unexpected secret");
      if (url.pathname === "/login/oauth/access_token" && fields.get("grant_type") === "refresh_token") {
        const id = /^fixture-refresh-([ab])$/u.exec(fields.get("refresh_token") ?? "")?.[1];
        if (!id) throw new Error("Unknown fixture refresh credential");
        const state = JSON.parse(await readFile(stateFile, "utf8")) as { oauthRefreshes?: string[] };
        (state.oauthRefreshes ??= []).push(id);
        await writeFile(stateFile, JSON.stringify(state));
        return Response.json({ token_type: "bearer", access_token: `fixture-private-${id}`, expires_in: 3600, refresh_token: `fixture-rotated-${id}`, refresh_token_expires_in: 86400 });
      }
      if (url.pathname === "/login/device/code") return Response.json({ device_code: "fixture-hidden-device", user_code: "PIAA-TEST", verification_uri: "https://github.com/login/device", expires_in: 600, interval: 1 });
      if (url.pathname === "/login/oauth/access_token") {
        const state = JSON.parse(await readFile(stateFile, "utf8")) as { deviceApproved?: boolean };
        return Response.json(state.deviceApproved
          ? { token_type: "bearer", access_token: "fixture-private-device", expires_in: 3600, refresh_token: "fixture-private-refresh", refresh_token_expires_in: 86400 }
          : { error: "authorization_pending" });
      }
    }
    if (url.origin !== "https://api.github.com") throw new Error("Fixture blocked an external host");
    const token = new Headers(init?.headers).get("authorization");
    const actor = token === "Bearer fixture-private-a" ? "a" : token === "Bearer fixture-private-b" ? "b"
      : token === "Bearer fixture-private-device" ? "device" : token === "Bearer fixture-private-bot" ? "bot"
      : token?.startsWith("Bearer ey") ? "app" : undefined;
    if (!actor) throw new Error("Wrong fixture credential");
    const state = JSON.parse(await readFile(stateFile, "utf8")) as {
      body: string; sequence: number; requests: { method: string; route: string; actor: string }[];
    };
    const method = init?.method ?? "GET";
    state.requests.push({ method, route: url.pathname, actor });
    const reply = async (value: unknown, status = 200) => {
      await writeFile(stateFile, JSON.stringify(state));
      return Response.json(value, { status });
    };
    if (url.pathname === "/app") return reply({ id: 123, slug: "fixture-app" });
    if (url.pathname === "/app/installations") return reply([{ id: 456, account: { login: "fixture-account" }, repository_selection: "selected", suspended_at: null }]);
    if (["/app/installations/456/access_tokens", "/app/installations/457/access_tokens"].includes(url.pathname))
      return reply({ token: `fixture-private-${url.pathname.includes("/456/") ? "a" : "b"}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (url.pathname === "/repos/example/project/forbidden")
      return actor === "a" ? reply({ allowed: true }) : reply({ message: "Fixture permission denied" }, 403);
    if (url.pathname === "/users/fixture-app%5Bbot%5D") return reply({ id: 99, login: "fixture-app[bot]" });
    if (url.pathname === "/user") return reply({ id: 42, login: "same-user", name: "Fixture user" });
    if (url.pathname === "/repos/example/project") return reply({ id: 1, name: "project", full_name: "example/project", owner: { login: "example" } });
    const number = url.pathname.endsWith("/13") ? 13 : 12;
    const issue = () => ({ number, id: number, title: "Connection fixture", body: state.body, state: "open",
      updated_at: `revision-${state.sequence}`, html_url: `https://github.com/example/project/issues/${number}`,
      repository_url: "https://api.github.com/repos/example/project", labels: [], assignees: [], milestone: null });
    if (["/repos/example/project/issues/12", "/repos/example/project/issues/13"].includes(url.pathname)) {
      if (method === "PATCH") { state.body = String(JSON.parse(String(init?.body)).body); state.sequence++; }
      return reply(issue());
    }
    if (url.pathname === "/repos/example/project/raw-cache-race" && method === "POST") {
      state.sequence++;
      const response = await reply({ id: 99 }, 201);
      const get = response.headers.get.bind(response.headers);
      let switched = false;
      response.headers.get = (name: string) => {
        if (name.toLowerCase() === "link" && !switched) {
          switched = true;
          queueMicrotask(() => connections.useProfile(actor === "a" ? "b" : "a"));
        }
        return get(name);
      };
      return response;
    }
    if (url.pathname === "/repos/example/project/issues" && method === "POST") {
      state.sequence++;
      await writeFile(stateFile, JSON.stringify(state));
      connections.useProfile(actor === "a" ? "b" : "a");
      throw new Error("Fixture response lost after effect");
    }
    return reply({ message: "Fixture resource not found" }, 404);
  };
  connections = new GithubConnections({ store, fetcher, legacyConfig: async () => undefined });
  registerGithubAuthCommands(pi, connections, { fetcher });
  pi.on("session_shutdown", () => connections.dispose());
  await registerGithubProvider(pi, new GithubBackend((directory) => connections.clientFor(directory)), undefined, connections);
  await afterSetup?.(connections);
  pi.registerTool({
    name: "fixture_switch", label: "Fixture switch", description: "Test-only explicit switch between two connection profiles.",
    parameters: Type.Object({ profile: Type.Union([Type.Literal("a"), Type.Literal("b")]) }),
    async execute(_id, args) {
      connections.useProfile(args.profile);
      return { content: [{ type: "text", text: `Selected fixture profile ${args.profile}` }], details: { profile: args.profile } };
    },
  });
}
