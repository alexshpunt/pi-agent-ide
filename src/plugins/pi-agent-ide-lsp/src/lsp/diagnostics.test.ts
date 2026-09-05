import { pathToFileURL } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import { LspClient } from "./client.js";
import { requestDiagnostics } from "./diagnostics.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pushClient(timeoutMs = 30_000) {
  const client = new LspClient({
    serverId: "push-server",
    rootUri: "file:///project",
    command: ["unused"],
    timeoutMs,
  });
  vi.spyOn(client, "sendRequest").mockRejectedValue({ code: -32601 });
  const unsubscribe = vi.fn();
  let publish: (parameters: unknown) => void = () => {};
  vi.spyOn(client, "onNotification").mockImplementation((_method, handler) => {
    publish = handler;
    return unsubscribe;
  });
  let version: number | undefined;
  vi.spyOn(client, "documentVersion").mockImplementation(() => version);
  const synced = new Promise<void>((resolve) => {
    vi.spyOn(client, "syncDocument").mockImplementation(() => {
      version = (version ?? 0) + 1;
      resolve();
    });
  });
  return {
    client,
    unsubscribe,
    synced,
    publish: (parameters: unknown) => publish(parameters),
  };
}

const uri = pathToFileURL(import.meta.filename).href;

test("push diagnostics wait beyond 500ms without a server capability flag", async () => {
  vi.useFakeTimers();
  const { client, publish, unsubscribe, synced } = pushClient();
  const pending = requestDiagnostics(client, uri, "typescript");
  await synced;
  await vi.advanceTimersByTimeAsync(1000);
  publish({
    uri,
    diagnostics: [
      {
        code: 2322,
        message: "Wrong type",
        severity: 1,
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
      },
    ],
  });
  expect((await pending).diagnostics).toEqual([
    { code: "2322", message: "Wrong type", severity: "error", line: 2, column: 3 },
  ]);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(client.hasActiveDiagnosticRequest(uri)).toBe(false);
});

test("TypeScript waits for every completed report, not an early empty publication", async () => {
  const { client } = pushClient();
  vi.spyOn(client, "supportsCommand").mockReturnValue(true);
  let resolveSemantic: (value: unknown) => void = () => {};
  const semantic = new Promise<unknown>((resolve) => {
    resolveSemantic = resolve;
  });
  vi.mocked(client.sendRequest).mockImplementation(async (method, parameters) => {
    if (method === "textDocument/diagnostic")
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    const args = parameters as { arguments: [string] };
    return args.arguments[0] === "semanticDiagnosticsSync" ? semantic : { success: true, body: [] };
  });
  let settled = false;
  const pending = requestDiagnostics(client, uri, "typescript", { content: "bad" }).then(
    (result) => {
      settled = true;
      return result;
    },
  );
  await vi.waitFor(() => expect(client.sendRequest).toHaveBeenCalledTimes(4));
  expect(settled).toBe(false);
  resolveSemantic({
    success: true,
    body: [
      {
        message: "Wrong type",
        category: "error",
        code: 2322,
        startLocation: { line: 2, offset: 3 },
      },
    ],
  });
  expect(await pending).toMatchObject({
    complete: true,
    unversioned: false,
    diagnostics: [{ code: "2322", line: 2, column: 3 }],
  });
});

test("standard pull stays language independent and takes priority over an adapter", async () => {
  const { client } = pushClient();
  vi.spyOn(client, "supportsCommand").mockReturnValue(true);
  vi.mocked(client.sendRequest).mockResolvedValue({ kind: "full", items: [] });
  expect(await requestDiagnostics(client, uri, "cpp")).toMatchObject({
    complete: true,
    diagnostics: [],
  });
  expect(client.sendRequest).toHaveBeenCalledTimes(1);
});

test("TypeScript rejects a malformed completed response instead of falling back to push", async () => {
  const { client } = pushClient();
  vi.spyOn(client, "supportsCommand").mockReturnValue(true);
  vi.mocked(client.sendRequest).mockImplementation(async (method) => {
    if (method === "textDocument/diagnostic")
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    return { success: false };
  });
  await expect(requestDiagnostics(client, uri, "typescript")).rejects.toThrow(
    "Invalid completed TypeScript",
  );
});

test("a file revision change invalidates an adapter response", async () => {
  const { client } = pushClient();
  vi.spyOn(client, "supportsCommand").mockReturnValue(true);
  vi.mocked(client.sendRequest).mockImplementation(async (method) => {
    if (method === "textDocument/diagnostic")
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    client.syncDocument(uri, "new revision", "typescript");
    return { success: true, body: [] };
  });
  await expect(requestDiagnostics(client, uri, "typescript")).rejects.toThrow("Document changed");
});

test.each([undefined, 1])("an empty push is only a snapshot (version %s)", async (version) => {
  vi.useFakeTimers();
  const { client, publish, synced } = pushClient();
  const pending = requestDiagnostics(client, uri, "typescript");
  await synced;
  await vi.advanceTimersByTimeAsync(0);
  publish({ uri, diagnostics: [], version });
  expect(await pending).toMatchObject({
    diagnostics: [],
    complete: false,
    unversioned: version === undefined,
  });
});

test("a cached current push is reused without sending a duplicate didChange", async () => {
  const { client } = pushClient();
  vi.mocked(client.documentVersion).mockReturnValue(7);
  vi.spyOn(client, "diagnosticPublication").mockReturnValue({ version: 7, diagnostics: [] });
  expect(await requestDiagnostics(client, uri, "cpp")).toMatchObject({
    complete: false,
    unversioned: false,
    diagnostics: [],
  });
  expect(client.syncDocument).not.toHaveBeenCalled();
});

test("an aborted request sends no diagnostic commands", async () => {
  const { client } = pushClient();
  const controller = new AbortController();
  controller.abort(new Error("Old revision"));
  await expect(
    requestDiagnostics(client, uri, "typescript", { signal: controller.signal }),
  ).rejects.toThrow("Old revision");
  expect(client.sendRequest).not.toHaveBeenCalled();
});

test("a missing push notification fails at the configured timeout instead of reporting a clean file", async () => {
  vi.useFakeTimers();
  const { client, unsubscribe, publish, synced } = pushClient(1200);
  const pending = requestDiagnostics(client, uri, "typescript");
  const assertion = expect(pending).rejects.toThrow("diagnostics timed out");
  await synced;
  await vi.advanceTimersByTimeAsync(1000);
  publish({ uri: "file:///project/other.ts", diagnostics: [] });
  expect(client.hasActiveDiagnosticRequest(uri)).toBe(true);
  await vi.advanceTimersByTimeAsync(200);
  await assertion;
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(client.hasActiveDiagnosticRequest(uri)).toBe(false);
});
