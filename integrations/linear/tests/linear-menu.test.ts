import { fixtureHost } from "./fixtures/check.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { createLinearCommandHandler } from "#linear/auth-ui.ts";
import type { AuthRunner } from "#linear/auth-process.ts";

const id = "11111111-1111-4111-8111-111111111111";
const profile = {
  state: "connected" as const,
  epoch: "one",
  connectionId: id,
  name: "Work",
  method: "api-key" as const,
};

function context(choices: number[]) {
  return fixtureHost<ExtensionCommandContext>({
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: {
      select: vi.fn(async (_title: string, options: string[]) => {
        const choice = choices.shift();
        return choice === undefined ? undefined : options[choice];
      }),
      notify: vi.fn(),
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "Named connection"),
      custom: async () => {
        throw new Error("This fixture does not submit credentials");
      },
    },
  });
}

test("selecting a session account leaves the global default unchanged and returns to the menu", async () => {
  const ctx = context([2, 1, 0]);
  const run = vi.fn<AuthRunner>(async (_cwd, args) =>
    args[0] === "list" ? { ...profile, connections: [profile] } : profile,
  );
  const select = vi.fn();
  await createLinearCommandHandler(run, () => {}, undefined, undefined, {
    selection: { get: () => "none", select, restore: async () => {} },
  })("", ctx);
  expect(run.mock.calls.map((call) => call[1][0])).toEqual(["list", "select"]);
  expect(select).toHaveBeenCalledWith(id, ctx);
  expect(ctx.ui.select).toHaveBeenCalledTimes(4);
});

test("selecting a global default does not change this session", async () => {
  const ctx = context([2, 0, 0]);
  const run = vi.fn<AuthRunner>(async (_cwd, args) =>
    args[0] === "list" ? { ...profile, connections: [profile] } : profile,
  );
  const select = vi.fn();
  await createLinearCommandHandler(run, () => {}, undefined, undefined, {
    selection: { get: () => "none", select, restore: async () => {} },
  })("", ctx);
  expect(run.mock.calls.map((call) => call[1][0])).toEqual(["list", "default"]);
  expect(select).not.toHaveBeenCalled();
});

test("logging out revokes the chosen grant and clears only the current session when it selected that grant", async () => {
  const ctx = context([1, 0]);
  const oauth = {
    ...profile,
    credentialType: "oauth" as const,
    capabilities: { revoke: true, native: true, mcp: true, storage: true, refresh: false },
  };
  const run = vi.fn<AuthRunner>(async (_cwd, args) =>
    args[0] === "list" ? { ...oauth, connections: [oauth] } : oauth,
  );
  const select = vi.fn();
  const report = vi.fn();
  await createLinearCommandHandler(run, () => {}, undefined, report, {
    selection: { get: () => id, select, restore: async () => {} },
  })("", ctx);
  expect(run.mock.calls.map((call) => call[1][0])).toEqual(["list", "epoch", "revoke"]);
  expect(run.mock.calls[2]?.[2]).toMatchObject({ connectionId: id, expectedEpoch: "one" });
  expect(select).toHaveBeenCalledWith(null, ctx);
  expect(report.mock.calls.at(-1)?.[1]).toMatch(/revoked/i);
});
test("logout reports uncertain remote revocation after an independently confirmed local removal", async () => {
  const ctx = context([1, 0]);
  const oauth = {
    ...profile,
    credentialType: "oauth" as const,
    capabilities: { revoke: true, native: true, mcp: true, storage: true, refresh: false },
  };
  let reads = 0;
  const run = vi.fn<AuthRunner>(async (_cwd, args) => {
    if (args[0] === "list") return { ...oauth, connections: [oauth] };
    if (args[0] === "revoke") throw new Error("LINEAR_AUTH_REVOKE_UNKNOWN");
    if (args[0] === "epoch" && reads++) throw new Error("LINEAR_AUTH_CONNECTION_REMOVED");
    return oauth;
  });
  const report = vi.fn();
  await createLinearCommandHandler(run, () => {}, undefined, report)("", ctx);
  expect(report.mock.calls.at(-1)?.[1]).toMatch(/forgotten locally.*uncertain.*manually/i);
  expect(report.mock.calls.at(-1)?.[2]).toBe("warning");
});
test("cancelling login before choosing a method leaves the session and saved connections untouched", async () => {
  const ctx = context([0]);
  const run = vi.fn<AuthRunner>(async () => profile);
  const select = vi.fn();
  await createLinearCommandHandler(run, () => {}, undefined, undefined, {
    selection: { get: () => id, select, restore: async () => {} },
  })("", ctx);
  expect(run).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});

test("API key logout gives manual revocation guidance", async () => {
  const ctx = context([1, 0]);
  const run = vi.fn<AuthRunner>(async (_cwd, args) =>
    args[0] === "list"
      ? { ...profile, connections: [profile] }
      : { ...profile, credentialType: "api-key" },
  );
  const report = vi.fn();
  await createLinearCommandHandler(run, () => {}, undefined, report)("", ctx);
  expect(run.mock.calls.map((call) => call[1][0])).toEqual(["list", "epoch", "logout"]);
  expect(report.mock.calls.at(-1)?.[1]).toMatch(/forgotten locally.*unavailable.*manually/i);
});
test("the OAuth menu starts MCP login without importing a token", async () => {
  const ctx = context([0, 0, 0, 0]);
  const run = vi.fn<AuthRunner>(async () => profile);
  await createLinearCommandHandler(run)("", ctx);
  expect(run.mock.calls[0]?.[1]).toContain("mcp");
  expect(run.mock.calls[0]?.[1]).not.toContain("import");
});
