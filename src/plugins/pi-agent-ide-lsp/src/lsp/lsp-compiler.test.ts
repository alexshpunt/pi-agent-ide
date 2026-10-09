import { expect, test, vi } from "vitest";
import { createLspCompiler } from "./lsp-compiler.js";
import type { LspManager } from "./manager.js";
import { LspClient } from "./client.js";

// Missing capability must be a refusal, not a clean compiler result.
test("compiler resolves its manager from the actual source owner", async () => {
  const filePath = "ssh://fixture/project/note.ts";
  const signal = new AbortController().signal;
  const openFile = vi.fn<LspManager["openFile"]>().mockResolvedValue(null);
  const managerForFile = vi
    .fn<(cwd: string, filePath: string) => Promise<Pick<LspManager, "openFile">>>()
    .mockResolvedValue({ openFile });
  const compiler = createLspCompiler(managerForFile);
  await expect(compiler.compile({ filePath }, { cwd: "/controller", signal })).rejects.toThrow(
    "No diagnostic language server for this source",
  );
  expect(managerForFile).toHaveBeenCalledWith("/controller", filePath, signal);
  expect(openFile).toHaveBeenCalledWith(filePath, "/controller", "diagnostics", signal);
});

test("compiler returns errors from a completed owner report and can restart that client", async () => {
  const uri = "ssh://fixture/project/note.ts";
  const client = new LspClient({
    serverId: "owned",
    rootUri: "ssh://fixture/project",
    command: ["unused"],
  });
  vi.spyOn(client, "sendRequest").mockResolvedValue({
    kind: "full",
    items: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 1,
        code: 2322,
        message: "Type mismatch",
      },
    ],
  });
  const restart = vi.spyOn(client, "restart").mockResolvedValue(undefined);
  const openFile = vi
    .fn<LspManager["openFile"]>()
    .mockResolvedValue({ client, uri, languageId: "typescript" });
  const compiler = createLspCompiler(() => Promise.resolve({ openFile }));
  const result = await compiler.compile({ filePath: uri }, { cwd: "/controller" });
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toEqual([
    { line: 1, column: 1, severity: "error", code: "2322", message: "Type mismatch" },
  ]);
  expect(result.syntaxErrors).toEqual([]);
  if (!compiler.restart) throw new Error("Missing compiler restart");
  await compiler.restart();
  expect(restart).toHaveBeenCalledOnce();
});

test("an aborted compile does not resolve or launch a language server", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Compile cancelled"));
  const openFile = vi.fn<LspManager["openFile"]>().mockResolvedValue(null);
  const managerForFile = vi.fn(() => Promise.resolve({ openFile }));
  const compiler = createLspCompiler(managerForFile);
  await expect(
    compiler.compile(
      { filePath: "ssh://fixture/project/note.ts" },
      { cwd: "/controller", signal: controller.signal },
    ),
  ).rejects.toThrow("Compile cancelled");
  expect(managerForFile).not.toHaveBeenCalled();
});

test("a pending owner diagnostic request is cancelled instead of publishing a report", async () => {
  const controller = new AbortController();
  const uri = "ssh://fixture/project/note.ts";
  const client = new LspClient({
    serverId: "owned",
    rootUri: "ssh://fixture/project",
    command: ["unused"],
  });
  let announceRequest: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    announceRequest = resolve;
  });
  vi.spyOn(client, "sendRequest").mockImplementation(
    (_method, _params, signal) =>
      new Promise<never>((_resolve, reject) => {
        if (!signal) {
          reject(new Error("Missing diagnostic cancellation signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(signal.reason instanceof Error ? signal.reason : new Error("Cancelled")),
          { once: true },
        );
        announceRequest();
      }),
  );
  const compiler = createLspCompiler(() =>
    Promise.resolve({ openFile: () => Promise.resolve({ client, uri, languageId: "typescript" }) }),
  );
  const pending = compiler.compile(
    { filePath: uri },
    { cwd: "/controller", signal: controller.signal },
  );
  const failed = expect(pending).rejects.toThrow("Compile cancelled");
  await requested;
  controller.abort(new Error("Compile cancelled"));
  await failed;
});
