import { afterEach, expect, test, vi } from "vitest";
import { LspClient } from "./client.js";
import { LspManager } from "./manager.js";
import { LspServerRegistry } from "./registry.js";
import { readLspSymbolGraph } from "./code-views.js";
import { requestCallHierarchy } from "./navigation.js";
import { searchSymbols } from "./symbol-search.js";

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
const uri = "ssh://fixture/workspace/note.ts";
const item = { name: "label", kind: 14, uri, range, selectionRange: range };
function client(): LspClient {
  return new LspClient({
    serverId: "fixture",
    rootUri: "ssh://fixture/workspace",
    command: ["fixture"],
  });
}

test("missing symbol servers do not claim that a scoped search found no declarations", async () => {
  const manager = LspManager.init(
    LspServerRegistry.fromConfig({ version: 1, servers: {} }, "ssh://fixture/workspace"),
  );
  vi.spyOn(manager, "prepareWorkspaceSymbols").mockResolvedValue([]);
  await expect(
    searchSymbols("label", "ssh://fixture/workspace", 50, undefined, {}, manager),
  ).rejects.toThrow(/LSP symbol search is unavailable/u);
});
test("graph cancellation reaches every language server request", async () => {
  const connection = client();
  const requests = vi
    .spyOn(connection, "sendRequest")
    .mockImplementation(async (method) =>
      method === "textDocument/documentSymbol" || method === "textDocument/prepareCallHierarchy"
        ? [item]
        : [],
    );
  const manager = LspManager.init(
    LspServerRegistry.fromConfig({ version: 1, servers: {} }, "ssh://fixture/workspace"),
  );
  vi.spyOn(manager, "openFile").mockResolvedValue({
    client: connection,
    uri,
    languageId: "typescript",
  });
  const controller = new AbortController();
  await readLspSymbolGraph(manager, uri, ["label"], "/controller", controller.signal);
  expect(requests.mock.calls.map(([method]) => method).sort()).toEqual(
    [
      "textDocument/documentSymbol",
      "textDocument/references",
      "textDocument/prepareCallHierarchy",
      "callHierarchy/incomingCalls",
      "callHierarchy/outgoingCalls",
    ].sort(),
  );
  for (const call of requests.mock.calls) expect(call[2]).toBe(controller.signal);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await LspManager.resetForTest();
});

test("a reference server failure is not reported as an empty graph", async () => {
  const connection = client();
  vi.spyOn(connection, "sendRequest")
    .mockResolvedValueOnce([item])
    .mockRejectedValueOnce(Object.assign(new Error("Owned reference failure"), { code: -32603 }))
    .mockResolvedValueOnce(null);
  const manager = LspManager.init(
    LspServerRegistry.fromConfig({ version: 1, servers: {} }, "ssh://fixture/workspace"),
  );
  vi.spyOn(manager, "openFile").mockResolvedValue({
    client: connection,
    uri,
    languageId: "typescript",
  });
  await expect(readLspSymbolGraph(manager, uri, ["label"], "/controller")).rejects.toThrow(
    "Owned reference failure",
  );
});

test("reference queries load the advertised TypeScript project before reading unopened references", async () => {
  const connection = client();
  vi.spyOn(connection, "supportsCommand").mockReturnValue(true);
  vi.spyOn(connection, "serverDocumentPath").mockReturnValue("/workspace/note.ts");
  const requests = vi
    .spyOn(connection, "sendRequest")
    .mockResolvedValueOnce({ success: true })
    .mockResolvedValueOnce([{ uri, range }]);
  const signal = new AbortController().signal;
  const { requestReferences } = await import("./navigation.js");
  expect(await requestReferences(connection, uri, range.start, signal)).toEqual([{ uri, range }]);
  expect(requests.mock.calls.map(([method]) => method)).toEqual([
    "workspace/executeCommand",
    "textDocument/references",
  ]);
  expect(requests.mock.calls[0]).toEqual([
    "workspace/executeCommand",
    {
      command: "typescript.tsserverRequest",
      arguments: [
        "projectInfo",
        { file: "/workspace/note.ts", needFileNameList: true },
        { isAsync: false, expectsResult: true },
      ],
    },
    signal,
  ]);
  expect(requests.mock.calls[1]?.[2]).toBe(signal);
});

test("a failed advertised project load cannot become a partial reference result", async () => {
  const connection = client();
  vi.spyOn(connection, "supportsCommand").mockReturnValue(true);
  vi.spyOn(connection, "serverDocumentPath").mockReturnValue("/workspace/note.ts");
  const requests = vi.spyOn(connection, "sendRequest").mockResolvedValue({ success: false });
  const { requestReferences } = await import("./navigation.js");
  await expect(requestReferences(connection, uri, range.start)).rejects.toThrow(
    /load the project/u,
  );
  expect(requests).toHaveBeenCalledTimes(1);
});
for (const code of [-32601, -32603]) {
  test(`incoming call failure ${code} is reported instead of an empty graph`, async () => {
    const connection = client();
    vi.spyOn(connection, "sendRequest")
      .mockResolvedValueOnce([item])
      .mockRejectedValueOnce(Object.assign(new Error("Owned incoming failure"), { code }))
      .mockResolvedValueOnce([]);
    const result = requestCallHierarchy(connection, uri, range.start);
    await expect(result).rejects.toMatchObject({ message: "Owned incoming failure", code });
  });
}
