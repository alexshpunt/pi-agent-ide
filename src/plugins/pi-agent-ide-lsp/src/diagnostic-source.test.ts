import { afterEach, expect, test, vi } from "vitest";
import { createLspDiagnosticSource } from "./diagnostic-source.js";
import { LspClient } from "./lsp/client.js";
import type { LspPushDiagnosticsEvent } from "./lsp/manager.js";

afterEach(() => vi.restoreAllMocks());

test("late empty TypeScript pushes requery complete reports without resyncing the document", async () => {
  const client = new LspClient({
    serverId: "custom-name",
    rootUri: "file:///project",
    command: ["unused"],
  });
  vi.spyOn(client, "supportsCommand").mockReturnValue(true);
  vi.spyOn(client, "syncDocument").mockImplementation(() => {});
  vi.spyOn(client, "documentVersion").mockReturnValue(1);
  vi.spyOn(client, "sendRequest").mockImplementation(async (method, parameters) => {
    if (method === "textDocument/diagnostic")
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    const args = parameters as { arguments: [string] };
    return {
      success: true,
      body:
        args.arguments[0] === "semanticDiagnosticsSync"
          ? [
              {
                message: "Wrong type",
                category: "error",
                code: 2322,
                startLocation: { line: 1, offset: 1 },
              },
            ]
          : [],
    };
  });
  type Event = LspPushDiagnosticsEvent;
  let push: (event: Event) => void = () => {};
  const unsubscribe = vi.fn();
  const manager = {
    getOrStart: async () => client,
    languageId: () => "typescript",
    onPushDiagnostics: (handler: typeof push) => {
      push = handler;
      return unsubscribe;
    },
  };
  const controller = new AbortController();
  const publish = vi.fn();
  const report = await createLspDiagnosticSource(async () => manager).diagnose("/project/file.ts", {
    cwd: "/project",
    content: "bad",
    signal: controller.signal,
    publish,
  });
  expect(report).toMatchObject({ status: "ready", diagnostics: [{ code: "2322" }] });
  push({
    uri: client.toUri("/project/file.ts"),
    serverId: "custom-name",
    cwd: "/project",
    diagnostics: [],
  });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "ready",
      diagnostics: [expect.objectContaining({ code: "2322" })],
    }),
  );
  expect(client.syncDocument).toHaveBeenCalledOnce();
  controller.abort();
  expect(unsubscribe).toHaveBeenCalledOnce();
  push({
    uri: client.toUri("/project/file.ts"),
    serverId: "custom-name",
    cwd: "/project",
    diagnostics: [],
  });
  expect(publish).toHaveBeenCalledOnce();
});
