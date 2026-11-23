import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { LspClient } from "./client.ts";
import { loadQueryProject } from "./project.ts";
import { requestWorkspaceSymbols } from "./symbols.ts";

afterEach(() => vi.restoreAllMocks());

function client() {
  return new LspClient({
    serverId: "fixture",
    rootUri: pathToFileURL(process.cwd()).href,
    command: ["fixture"],
  });
}

test("loads unopened project files only through the server's advertised command", async () => {
  const provider = client();
  const supported = vi.spyOn(provider, "supportsCommand").mockReturnValue(false);
  const uri = pathToFileURL("/workspace/source.ts").href;
  const projectFiles = ["/workspace/source.ts", "/workspace/other.ts"];
  vi.spyOn(provider, "serverDocumentPath").mockReturnValue("/workspace/source.ts");
  const request = vi.spyOn(provider, "sendRequest").mockResolvedValue({
    success: true,
    body: { fileNames: projectFiles },
  });
  expect(await loadQueryProject(provider, uri)).toEqual([]);
  expect(request).not.toHaveBeenCalled();
  supported.mockReturnValue(true);
  const signal = new AbortController().signal;
  expect(await loadQueryProject(provider, uri, signal)).toEqual(projectFiles);
  expect(request).toHaveBeenCalledWith(
    "workspace/executeCommand",
    {
      command: "typescript.tsserverRequest",
      arguments: [
        "projectInfo",
        { file: "/workspace/source.ts", needFileNameList: true },
        { isAsync: false, expectsResult: true },
      ],
    },
    signal,
  );
});

test("workspace queries search all loaded TypeScript projects and exclude import aliases", async () => {
  const provider = client();
  vi.spyOn(provider, "supportsCommand").mockReturnValue(true);
  const file = "/workspace/frontend/src/source.ts";
  const declaration = {
    name: "renderLabel",
    kind: "function",
    file,
    start: { line: 2, offset: 4 },
    end: { line: 2, offset: 15 },
  };
  const request = vi.spyOn(provider, "sendRequest").mockResolvedValue({
    success: true,
    body: [{ ...declaration, kind: "alias", file: "/workspace/frontend/src/App.vue" }, declaration],
  });
  expect(await requestWorkspaceSymbols(provider, "renderLabel", 1)).toEqual([
    {
      name: "renderLabel",
      kind: 12,
      location: {
        uri: pathToFileURL(file).href,
        range: { start: { line: 1, character: 3 }, end: { line: 1, character: 14 } },
      },
    },
  ]);
  expect(request).toHaveBeenCalledWith(
    "workspace/executeCommand",
    {
      command: "typescript.tsserverRequest",
      arguments: ["navto", { searchValue: "renderLabel" }, { isAsync: false, expectsResult: true }],
    },
    undefined,
  );
});
