import { fixtureHost, required } from "./fixtures/check.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { createLinearAuthHandler, MaskedAuthInput } from "#linear/auth-ui.ts";
import type { AuthRunner, AuthStatus } from "#linear/auth-process.ts";

const connected: AuthStatus = {
  state: "connected",
  epoch: "next",
  credentialType: "api-key",
  actor: "user",
  identity: { id: "u1", name: "User", workspace: { id: "w1", slug: "example", name: "Example" } },
  capabilities: { mcp: true, native: true, storage: true, refresh: false, revoke: false },
};
const connectionId = "11111111-1111-4111-8111-111111111111";

test("switch selects a named profile in this chat without logging out or changing the default", async () => {
  const ctx = context();
  const profile = { ...connected, connectionId, name: "Work", method: "api-key" as const };
  const run = vi.fn<AuthRunner>(async (_cwd, args) =>
    args[0] === "list" ? { state: "signed-out", epoch: "list", connections: [profile] } : profile,
  );
  vi.mocked(ctx.ui.select).mockImplementation(async (_title, options) => options[0]);
  const select = vi.fn();
  await createLinearAuthHandler(run, () => {}, undefined, undefined, {
    selection: { get: () => "none", select, restore: async () => {} },
  })("switch", ctx);
  expect(run.mock.calls.map((call) => call[1][0])).toEqual(["list", "select"]);
  expect(select).toHaveBeenCalledWith(connectionId, ctx);
  expect(JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls)).toContain("Work");
});

test("a failed additional key does not replace the chat's selected profile", async () => {
  const ctx = context();
  vi.mocked(ctx.ui.input).mockResolvedValue("Second key");
  vi.mocked(ctx.ui.custom).mockResolvedValue("synthetic-private-key");
  const run = vi.fn<AuthRunner>(async () => {
    throw new Error("LINEAR_AUTH_INVALID_CREDENTIAL");
  });
  const select = vi.fn();
  await createLinearAuthHandler(run, () => {}, undefined, undefined, {
    selection: { get: () => connectionId, select, restore: async () => {} },
  })("key", ctx);
  expect(run).toHaveBeenCalledWith(
    ctx.cwd,
    ["import"],
    expect.objectContaining({
      connectionId,
      input: { type: "api-key", token: "synthetic-private-key", name: "Second key" },
    }),
  );
  expect(select).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls)).not.toContain(
    "synthetic-private-key",
  );
  expect(JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls)).not.toContain("Log out");
});

test("browser login opens the validated link and explains manual fallback without failing login", async () => {
  const ctx = context();
  vi.mocked(ctx.ui.input).mockResolvedValue("MCP account");
  const url = "https://mcp.linear.app/authorize?state=synthetic-private-state";
  const run = vi.fn<AuthRunner>(async (_cwd, args, options) => {
    expect(args).toContain("mcp");
    options?.onAuthorization?.(url);
    return { ...connected, connectionId, name: "MCP account", method: "mcp-oauth" };
  });
  const openBrowser = vi.fn(async () => false);
  await createLinearAuthHandler(run, () => {}, undefined, undefined, { openBrowser })("login", ctx);
  expect(openBrowser).toHaveBeenCalledExactlyOnceWith(url);
  const notices = JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls);
  expect(notices).toContain(url);
  expect(notices).toContain("manually");
  expect(notices).not.toContain("LINEAR_AUTH_COMMAND_FAILED");
});
test.each([
  ["app", 1, "read,write,comments:create,app:assignable"],
  ["app", 0, "read"],
  ["user", 1, "read,write"],
  ["login", 1, "read,write"],
] as const)(
  "the %s flow sends the chosen permission profile without reducing app grants",
  async (action, choice, scopes) => {
    const ctx = context();
    let selection = 0;
    vi.mocked(ctx.ui.select).mockImplementation(async (_title, options) =>
      action === "app" && selection++ === 0 ? options[1] : options[choice],
    );
    const run = vi.fn<AuthRunner>(async () => connected);
    await createLinearAuthHandler(run)(action, ctx);
    const args = required(run.mock.calls[0])[1];
    expect(args[args.indexOf("--scope") + 1]).toBe(scopes);
    expect(args[args.indexOf("--actor") + 1]).toBe(action === "app" ? "app" : "user");
    expect(args[args.indexOf("--method") + 1]).toBe(action === "login" ? "mcp" : "oauth");
  },
);
test("connecting an installed App never starts browser OAuth or changes the default", async () => {
  const ctx = context();
  vi.mocked(ctx.ui.select).mockImplementation(async (_title, options) => options[0]);
  const profile = {
    ...connected,
    actor: "app" as const,
    credentialType: "oauth" as const,
    connectionId,
  };
  const run = vi.fn<AuthRunner>(async () => profile);
  const openBrowser = vi.fn();
  const select = vi.fn();
  await createLinearAuthHandler(run, () => {}, undefined, undefined, {
    openBrowser,
    selection: { get: () => "none", select, restore: async () => {} },
  })("app", ctx);
  expect(run).toHaveBeenCalledExactlyOnceWith(
    ctx.cwd,
    ["connect-app", "--name", "Named connection"],
    expect.anything(),
  );
  expect(openBrowser).not.toHaveBeenCalled();
  expect(select).toHaveBeenCalledWith(connectionId, ctx);
  expect(vi.mocked(ctx.ui.select)).toHaveBeenCalledOnce();
});
function context() {
  return fixtureHost<ExtensionCommandContext>({
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: {
      notify: vi.fn(),
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "Read and write"),
      custom: vi.fn(),
      input: vi.fn(async () => "Named connection"),
    },
  });
}
test("masked credential entry never renders the credential and clears its buffer after submit", () => {
  const done = vi.fn(),
    component = new MaskedAuthInput("API key", done, () => {});
  component.handleInput("private-secret-value");
  for (const width of [10, 40, 100])
    expect(component.render(width).join("\n")).not.toContain("private-secret-value");
  component.handleInput("\r");
  expect(done).toHaveBeenCalledWith("private-secret-value");
  expect(component.render(80).join("\n")).not.toContain("private-secret-value");
});
test("local logout invokes no remote revoke and invalidates local observations", async () => {
  const run = vi.fn<AuthRunner>(async (_cwd, args) =>
    args[0] !== "logout" ? { ...connected, connectionId } : { state: "signed-out", epoch: "next" },
  );
  const invalidate = vi.fn();
  const ctx = context();
  await createLinearAuthHandler(run, invalidate)("logout", ctx);
  expect(run).toHaveBeenCalledWith(ctx.cwd, ["logout"], expect.anything());
  expect(run.mock.calls.some((call) => call[1].includes("revoke"))).toBe(false);
  expect(ctx.ui.confirm).toHaveBeenCalledOnce();
  expect(JSON.stringify(vi.mocked(ctx.ui.confirm).mock.calls)).toContain("every chat");
  expect(run).toHaveBeenCalledWith(
    ctx.cwd,
    ["logout"],
    expect.objectContaining({ expectedEpoch: "next", connectionId }),
  );
  expect(invalidate).toHaveBeenCalledOnce();
});
test("removing a rejected non-current key keeps this chat's working selection", async () => {
  const ctx = context();
  const otherId = "22222222-2222-4222-8222-222222222222";
  const current = { ...connected, connectionId, name: "Working", method: "api-key" as const };
  const rejected = {
    ...connected,
    connectionId: otherId,
    name: "Rejected",
    method: "api-key" as const,
  };
  const run = vi.fn<AuthRunner>(async (_cwd, args, options) => {
    if (args[0] === "status") throw new Error("LINEAR_AUTH_INVALID_CREDENTIAL");
    if (args[0] === "list") return { ...current, connections: [current, rejected] };
    if (args[0] === "epoch") return rejected;
    expect(args).toEqual(["logout"]);
    expect(options).toMatchObject({ connectionId: otherId, expectedEpoch: "next" });
    return { state: "signed-out", epoch: "removed" };
  });
  vi.mocked(ctx.ui.select).mockImplementation(async (_title, labels) => labels[1]);
  const select = vi.fn();
  await createLinearAuthHandler(run, () => {}, undefined, undefined, {
    selection: { get: () => connectionId, select, restore: async () => {} },
  })("remove", ctx);
  expect(run.mock.calls.map((call) => call[1][0])).toEqual(["list", "epoch", "logout"]);
  expect(ctx.ui.confirm).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
});
test("an invalid saved key can be removed without reauthorizing it first", async () => {
  const ctx = context();
  const run = vi.fn<AuthRunner>(async (_cwd, args) => {
    if (args[0] === "status") throw new Error("LINEAR_AUTH_INVALID_CREDENTIAL");
    return args[0] === "epoch"
      ? { ...connected, connectionId }
      : { state: "signed-out", epoch: "removed" };
  });
  await createLinearAuthHandler(run)("logout", ctx);
  expect(run.mock.calls.map((call) => call[1][0])).toEqual(["epoch", "logout"]);
  expect(ctx.ui.confirm).toHaveBeenCalledOnce();
});
test("revocation denial checks identity but never dispatches revocation", async () => {
  const run = vi.fn<AuthRunner>(async () => ({
      ...connected,
      credentialType: "oauth",
      capabilities: { ...required(connected.capabilities), revoke: true },
    })),
    ctx = context();
  vi.mocked(ctx.ui.confirm).mockResolvedValue(false);
  await createLinearAuthHandler(run)("revoke", ctx);
  expect(run).toHaveBeenCalledExactlyOnceWith(ctx.cwd, ["status"], expect.anything());
});
test("revocation dispatch is pinned to the identity shown before confirmation", async () => {
  const ctx = context();
  let current = "A";
  vi.mocked(ctx.ui.confirm).mockImplementation(async (_title, message) => {
    expect(message).toContain("User");
    current = "B";
    return true;
  });
  const run = vi.fn<AuthRunner>(async (_cwd, args, options) => {
    if (args[0] === "status")
      return {
        ...connected,
        epoch: current,
        credentialType: "oauth",
        capabilities: { ...required(connected.capabilities), revoke: true },
      };
    expect(args).toEqual(["revoke"]);
    expect(options).toMatchObject({ expectedEpoch: "A" });
    throw new Error("LINEAR_AUTH_CONTEXT_CHANGED");
  });
  await createLinearAuthHandler(run)("revoke", ctx);
  expect(current).toBe("B");
  expect(run).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls)).toContain(
    "LINEAR_AUTH_CONTEXT_CHANGED",
  );
});
test("credential arguments are rejected rather than passed to the backend", async () => {
  const run = vi.fn<AuthRunner>(async () => connected),
    ctx = context();
  await createLinearAuthHandler(run)("key accidental-secret", ctx);
  expect(run).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls)).not.toContain("accidental-secret");
});
test("headless commands explain the CLI route without asking for secret input", async () => {
  const run = vi.fn<AuthRunner>(async () => connected),
    ctx = context();
  Object.assign(ctx, { hasUI: false, mode: "json" });
  await expect(createLinearAuthHandler(run)("key", ctx)).rejects.toThrow("interactive");
  expect(run).not.toHaveBeenCalled();
});
test("status names the actual identity and capability limits without calling login", async () => {
  const run = vi.fn<AuthRunner>(async () => connected),
    ctx = context();
  await createLinearAuthHandler(run)("status", ctx);
  expect(run).toHaveBeenCalledWith(ctx.cwd, ["status"], expect.anything());
  expect(JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls)).toContain("example");
  expect(JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls)).toContain("User");
});
