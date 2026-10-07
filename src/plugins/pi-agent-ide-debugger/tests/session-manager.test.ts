import net from "node:net";

import { afterEach, expect, test, vi } from "vitest";

import { DapClient } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});

async function sessionFixture() {
  const server = net.createServer();
  cleanup.push(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test port");
  const connected = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
  const client = await DapClient.connect(address.port);
  cleanup.push(() => client.close());
  const adapter = await connected;
  cleanup.push(() => adapter.destroy());
  const manager = new DebugSessionManager();
  const session = manager.create({
    adapter: "debugpy",
    program: "fixture.py",
    cwd: process.cwd(),
    args: [],
  });
  session.client = client;
  session.status = "stopped";
  session.stopGeneration = 1;
  session.stop = {
    generation: 1,
    reason: "breakpoint",
    threadId: 1,
    frame: { id: 10, name: "main", line: 3 },
    variables: [{ name: "subtotal", value: "1", variablesReference: 0 }],
    sourceLines: [],
  };
  return { manager, session, client, adapter };
}

function frame(event: string, body: unknown) {
  const text = JSON.stringify({ seq: 1, type: "event", event, body });
  return `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`;
}

function answerLocals(client: DapClient, beforeStack?: () => Promise<void>) {
  vi.spyOn(client, "request").mockImplementation(async <T>(command: string): Promise<T> => {
    if (command === "stackTrace") await beforeStack?.();
    const responses: Record<string, unknown> = {
      evaluate: { result: "2", type: "int" },
      threads: { threads: [{ id: 1 }] },
      stackTrace: { stackFrames: [{ id: 10, name: "main", line: 4 }] },
      scopes: { scopes: [{ name: "Locals", variablesReference: 20 }] },
      variables: { variables: [{ name: "subtotal", value: "2", variablesReference: 0 }] },
    };
    if (!(command in responses)) throw new Error(`Unexpected request ${command}`);
    return responses[command] as T;
  });
}

test("failed initialization closes an outstanding launch without an unhandled rejection", async () => {
  const { manager, client } = await sessionFixture();
  const session = manager.create({
    adapter: "debugpy",
    program: "fixture.py",
    cwd: process.cwd(),
    args: [],
  });
  vi.spyOn(DapClient, "start").mockReturnValue(client);
  const request = client.request.bind(client);
  vi.spyOn(client, "request").mockImplementation(<T>(command: string, arguments_: unknown) =>
    command === "initialize" ? Promise.resolve({} as T) : request<T>(command, arguments_),
  );
  vi.spyOn(client, "waitForAnyEvent").mockRejectedValue(new Error("Initialization failed"));
  await expect(manager.start(session)).rejects.toThrow("Initialization failed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(session.status).toBe("configured");
  expect(session.client).toBeUndefined();
});

test("adapter binding reports a relocated breakpoint and later loss of verification", async () => {
  const { manager, session, client, adapter } = await sessionFixture();
  vi.spyOn(client, "request").mockResolvedValue({
    breakpoints: [{ id: 12, verified: true, line: 4 }],
  });
  const breakpoint = await manager.addBreakpoint(manager.sourceResource(session), 3);
  expect(breakpoint).toMatchObject({ line: 4, verified: true });
  const arrived = new Promise<void>((resolve) => client.onEvent(() => resolve()));
  adapter.write(frame("breakpoint", { breakpoint: { id: 12, verified: false, line: 5 } }));
  await arrived;
  await manager.refresh(session);
  expect(manager.breakpoint(breakpoint.source)).toMatchObject({ line: 5, verified: false });
});
test("refresh replaces a stopped snapshot when termination arrives later", async () => {
  const { manager, session, client, adapter } = await sessionFixture();
  const arrived = new Promise<void>((resolve) => client.onEvent(() => resolve()));
  adapter.write(frame("terminated", {}));
  await arrived;
  await manager.refresh(session);
  expect(manager.snapshot(session)).toMatchObject({ status: "terminated" });
  expect(manager.snapshot(session).stop).toBeUndefined();
});
test("refresh reconciles termination arriving while a late stop is captured", async () => {
  const { manager, session, client, adapter } = await sessionFixture();
  const stopped = new Promise<void>((resolve) =>
    client.onEvent((event) => {
      if (event.event === "stopped") resolve();
    }),
  );
  const terminated = new Promise<void>((resolve) =>
    client.onEvent((event) => {
      if (event.event === "terminated") resolve();
    }),
  );
  answerLocals(client, async () => {
    adapter.write(frame("terminated", {}));
    await terminated;
  });
  session.status = "running";
  session.stop = undefined;
  adapter.write(frame("stopped", { threadId: 1, reason: "breakpoint" }));
  await stopped;
  await manager.refresh(session);
  expect(manager.snapshot(session).status).toBe("terminated");
  expect(manager.snapshot(session).stop).toBeUndefined();
});
test("evaluation refreshes locals without creating a new stop", async () => {
  const { manager, session, client } = await sessionFixture();
  answerLocals(client);
  const changes: unknown[] = [];
  manager.onDidChange((snapshot) => changes.push(snapshot));
  expect(await manager.evaluate(session, "subtotal := subtotal + 1")).toMatchObject({
    result: "2",
  });
  expect(manager.snapshot(session).stop).toMatchObject({
    generation: 1,
    variables: [{ name: "subtotal", value: "2" }],
  });
  expect(changes).toHaveLength(1);
});

test.each(["stopped", "terminated"])(
  "refresh consumes a late %s event after an interrupted wait",
  async (event) => {
    const { manager, session, client, adapter } = await sessionFixture();
    answerLocals(client);
    session.status = "running";
    session.stop = undefined;
    const arrived = new Promise<void>((resolve) => client.onEvent(() => resolve()));
    adapter.write(frame(event, { threadId: 1, reason: "breakpoint" }));
    await arrived;
    await manager.refresh(session);
    expect(manager.snapshot(session).status).toBe(event === "stopped" ? "stopped" : "terminated");
    if (event === "stopped") expect(manager.snapshot(session).stop?.frame?.line).toBe(4);
    else expect(session.stop).toBeUndefined();
    await manager.refresh(session);
    expect(session.stopGeneration).toBe(event === "stopped" ? 2 : 1);
  },
);
