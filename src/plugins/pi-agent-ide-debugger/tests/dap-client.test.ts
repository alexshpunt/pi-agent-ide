import net from "node:net";

import { afterEach, expect, test } from "vitest";

import { DapClient } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";

const servers: net.Server[] = [];
const clients: DapClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.close();
});

async function silentClient(): Promise<DapClient> {
  const server = net.createServer(() => {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test port");
  const client = await DapClient.connect(address.port);
  clients.push(client);
  return client;
}

test("an adopted DAP socket exposes events immediately without consuming them", async () => {
  let resolveAdapterSocket: ((socket: net.Socket) => void) | undefined;
  const adapterSocket = new Promise<net.Socket>((resolve) => {
    resolveAdapterSocket = resolve;
  });
  const server = net.createServer((socket) => resolveAdapterSocket?.(socket));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test port");
  const socket = net.createConnection({ port: address.port, host: "127.0.0.1" });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const client = DapClient.fromSocket(socket, 2);
  clients.push(client);
  const observed = new Promise<string>((resolve) => {
    client.onEvent((event) => resolve(event.event));
  });
  const message = JSON.stringify({
    seq: 0,
    type: "event",
    event: "custom",
    body: { reason: "writeToStdin", text: "n" },
  });
  (await adapterSocket).write(
    `Content-Length: ${Buffer.byteLength(message, "utf8")}\r\n\r\n${message}`,
  );

  await expect(observed).resolves.toBe("custom");
  await expect(client.waitForEvent("custom")).resolves.toMatchObject({ event: "custom" });
});
test("an in-flight DAP request can be aborted", async () => {
  const client = await silentClient();
  const controller = new AbortController();
  const request = client.request("continue", {}, { signal: controller.signal });

  controller.abort();

  await expect(request).rejects.toThrow(/aborted/u);
});

test("duplicate stopped events are ignored until execution continues", async () => {
  let acceptAdapter: (socket: net.Socket) => void = () => {};
  const adapterConnected = new Promise<net.Socket>((resolve) => {
    acceptAdapter = resolve;
  });
  const server = net.createServer(acceptAdapter);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test port");
  const client = await DapClient.connect(address.port);
  clients.push(client);
  const adapterSocket = await adapterConnected;

  const stopped = { seq: 1, type: "event", event: "stopped", body: { threadId: 1 } };
  adapterSocket.write(frame(stopped));
  await expect(client.waitForEvent("stopped")).resolves.toMatchObject(stopped);

  adapterSocket.write(frame({ ...stopped, seq: 2 }));
  adapterSocket.write(frame({ seq: 3, type: "event", event: "continued" }));
  await expect(client.waitForAnyEvent(["stopped", "continued"])).resolves.toMatchObject({
    event: "continued",
  });

  adapterSocket.write(frame({ ...stopped, seq: 4 }));
  await expect(client.waitForEvent("stopped")).resolves.toMatchObject({ event: "stopped" });
});

test("an execution request allows an identical stopped event without continued", async () => {
  let acceptAdapter: (socket: net.Socket) => void = () => {};
  const adapterConnected = new Promise<net.Socket>((resolve) => {
    acceptAdapter = resolve;
  });
  const server = net.createServer(acceptAdapter);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test port");
  const client = await DapClient.connect(address.port);
  clients.push(client);
  const adapterSocket = await adapterConnected;

  const stopped = { seq: 1, type: "event", event: "stopped", body: { threadId: 1 } };
  adapterSocket.write(frame(stopped));
  await expect(client.waitForEvent("stopped")).resolves.toMatchObject(stopped);

  const request = client.request("continue", { threadId: 1 });
  const requestMessage = await readMessage(adapterSocket);
  adapterSocket.write(
    frame({ seq: 2, type: "response", request_seq: requestMessage.seq, success: true }),
  );
  adapterSocket.write(frame({ ...stopped, seq: 3 }));

  await expect(request).resolves.toBeUndefined();
  await expect(client.waitForEvent("stopped")).resolves.toMatchObject({ event: "stopped" });
});

async function readMessage(socket: net.Socket): Promise<{ readonly seq: number }> {
  return new Promise((resolve) => {
    socket.once("data", (chunk: Buffer) => {
      const separator = chunk.indexOf("\r\n\r\n");
      resolve(JSON.parse(chunk.subarray(separator + 4).toString("utf8")) as { seq: number });
    });
  });
}

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}
test("waiting for a debugger stop can be aborted", async () => {
  const client = await silentClient();
  const controller = new AbortController();
  const waiting = client.waitForAnyEvent(["stopped", "terminated"], 10_000, controller.signal);

  controller.abort();

  await expect(waiting).rejects.toThrow(/aborted/u);
});
