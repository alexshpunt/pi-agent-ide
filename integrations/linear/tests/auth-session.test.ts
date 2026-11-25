import { expect, test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSessionConnectionSelection } from "#linear/auth-session.ts";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
function session(id: string) {
  const entries: unknown[] = [];
  const append = vi.fn((customType: string, data: unknown) => {
    entries.push({ type: "custom", customType, data });
  });
  const context = {
    cwd: "/fixture",
    sessionManager: { getSessionId: () => id, getEntries: () => entries },
  } as ExtensionContext;
  return { entries, append, context };
}

test("a session snapshots the explicit default and resume does not inherit a later default", async () => {
  const f = session("session-a");
  let defaultId = a;
  const run = vi.fn(async () => ({
    state: "connected" as const,
    epoch: "fixture",
    connectionId: defaultId,
  }));
  const first = createSessionConnectionSelection(f.append, run);
  await first.restore(f.context);
  expect(first.get()).toBe(a);
  defaultId = b;
  const resumed = createSessionConnectionSelection(f.append, run);
  await resumed.restore(f.context);
  expect(resumed.get()).toBe(a);
  expect(run).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.entries)).not.toContain("token");
});

test("two chats select independently and a new chat uses the assigned default", async () => {
  const one = session("one"),
    two = session("two");
  const run = vi.fn(async () => ({
    state: "connected" as const,
    epoch: "fixture",
    connectionId: a,
  }));
  const left = createSessionConnectionSelection(one.append, run);
  const right = createSessionConnectionSelection(two.append, run);
  await left.restore(one.context);
  await right.restore(two.context);
  left.select(b, one.context);
  expect(left.get()).toBe(b);
  expect(right.get()).toBe(a);
});

test("logout is durable and never resolves the default again", async () => {
  const f = session("one");
  const run = vi.fn(async () => ({
    state: "connected" as const,
    epoch: "fixture",
    connectionId: a,
  }));
  const first = createSessionConnectionSelection(f.append, run);
  await first.restore(f.context);
  first.select(null, f.context);
  const resumed = createSessionConnectionSelection(f.append, run);
  await resumed.restore(f.context);
  expect(resumed.get()).toBe("none");
  expect(run).toHaveBeenCalledTimes(1);
});

test("defaultless sessions stay unselected and malformed persisted IDs fail closed", async () => {
  const f = session("one");
  const run = vi.fn(async () => ({ state: "signed-out" as const, epoch: "empty" }));
  const selection = createSessionConnectionSelection(f.append, run);
  await selection.restore(f.context);
  expect(selection.get()).toBe("none");
  expect(() =>
    selection.select(
      [...Array<string>(2).fill(".".repeat(2)), "another-file"].join("/"),
      f.context,
    ),
  ).toThrow("LINEAR_AUTH_INPUT_INVALID");
  f.entries.push({
    type: "custom",
    customType: "linear-connection",
    data: {
      sessionId: "one",
      connectionId: [...Array<string>(2).fill(".".repeat(2)), "other"].join("/"),
    },
  });
  await expect(selection.restore(f.context)).rejects.toThrow("LINEAR_AUTH_INPUT_INVALID");
});

test("a chat started before managed setup cannot silently adopt a later shared default", async () => {
  const f = session("legacy-chat");
  let configured = false;
  const run = vi.fn(async () =>
    configured
      ? { state: "connected" as const, epoch: "new-default", connectionId: b }
      : { state: "legacy" as const, epoch: "legacy" },
  );
  const first = createSessionConnectionSelection(f.append, run);
  await first.restore(f.context);
  expect(first.get()).toBe("none");
  configured = true;
  const resumed = createSessionConnectionSelection(f.append, run);
  await resumed.restore(f.context);
  expect(resumed.get()).toBe("none");
  expect(run).toHaveBeenCalledTimes(1);
});
test("an expired default without refresh does not become a new chat's usable selection", async () => {
  const f = session("new-chat");
  const run = vi.fn(async () => ({
    state: "expired" as const,
    epoch: "expired",
    connectionId: a,
    capabilities: { mcp: false, native: false, storage: false, refresh: false, revoke: false },
  }));
  const selection = createSessionConnectionSelection(f.append, run);
  await selection.restore(f.context);
  expect(selection.get()).toBe("none");
});
test("a failed initial lookup does not persist a false logout", async () => {
  const f = session("one");
  const run = vi.fn(async () => {
    throw new Error("LINEAR_AXI_NOT_FOUND");
  });
  const selection = createSessionConnectionSelection(f.append, run);
  await expect(selection.restore(f.context)).rejects.toThrow("LINEAR_AXI_NOT_FOUND");
  expect(f.append).not.toHaveBeenCalled();
});
