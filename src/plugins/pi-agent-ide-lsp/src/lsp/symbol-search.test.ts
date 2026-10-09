import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import type { ResolvedResultTargets } from "pi-agent-resource";
import { LspClient } from "./client.js";
import { LspManager } from "./manager.js";
import { LspServerRegistry } from "./registry.js";
import { searchSymbols } from "./symbol-search.js";

const workspaces: string[] = [];
afterEach(async () => {
  await LspManager.resetForTest();
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

async function fixture() {
  await mkdir(".tmp/symbol-search", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/symbol-search/case-"));
  workspaces.push(cwd);
  const content = '"😀"; same();\r\nsame();\r\n';
  await writeFile(path.join(cwd, "a.ts"), content);
  await writeFile(path.join(cwd, "b.ts"), "same();\n");
  await writeFile(path.join(cwd, "other.ts"), "same();\n");
  const location = (file: string, line: number, from: number, to: number) => ({
    uri: pathToFileURL(path.join(cwd, file)).href,
    range: { start: { line, character: from }, end: { line, character: to } },
  });
  const definitions = [
    { name: "same", kind: 12, location: location("a.ts", 0, 6, 10) },
    { name: "same", kind: 12, location: location("other.ts", 0, 0, 4) },
  ] as const;
  const client = new LspClient({
    serverId: "fixture",
    rootUri: pathToFileURL(cwd).href,
    command: ["fixture"],
  });
  const sendRequest = vi
    .spyOn(client, "sendRequest")
    .mockImplementation(async (method, parameters) => {
      const input = parameters as { textDocument?: { uri: string } };
      if (method === "workspace/symbol") return definitions;
      if (method === "textDocument/references")
        return input.textDocument?.uri === definitions[0].location.uri
          ? [definitions[0].location, location("a.ts", 1, 0, 4), location("b.ts", 0, 0, 4)]
          : [definitions[1].location];
      throw Error(`Unexpected request ${method}`);
    });
  const manager = LspManager.init(LspServerRegistry.fromConfig({ version: 1, servers: {} }, cwd));
  vi.spyOn(manager, "prepareWorkspaceSymbols").mockResolvedValue([client]);
  vi.spyOn(manager, "openFile").mockImplementation(async (file) => ({
    client,
    uri: pathToFileURL(file).href,
    languageId: "typescript",
  }));
  const resultScope: ResolvedResultTargets = {
    complete: true,
    targets: [
      {
        source: path.join(cwd, "a.ts"),
        expectedContent: content,
        ranges: [{ start: { lineNumber: 1, column: 6 }, end: { lineNumber: 1, column: 10 } }],
      },
    ],
  };
  return { cwd, manager, sendRequest, resultScope };
}

test("an explicitly excluded file is an empty scope, not an unavailable provider", async () => {
  const { cwd, manager } = await fixture();
  const result = await searchSymbols(
    "same",
    cwd,
    20,
    undefined,
    { path: "a.ts", exclude: "a.ts" },
    manager,
  );
  expect(result).toEqual({ hits: [], complete: true });
  expect(manager.prepareWorkspaceSymbols).not.toHaveBeenCalled();
});

test("keeps strict exact ranges while explicit navigation retains the originating symbol", async () => {
  const { cwd, manager, resultScope } = await fixture();
  const strict = await searchSymbols("same", cwd, 100, undefined, { resultScope }, manager);
  expect(strict).toMatchObject({
    complete: true,
    hits: [
      {
        source: path.join(cwd, "a.ts"),
        startColumn: 6,
        endColumn: 10,
        matchedText: "same",
        role: "definition",
      },
    ],
  });
  expect(strict.hits).toHaveLength(1);
  const navigation = await searchSymbols(
    "same",
    cwd,
    100,
    undefined,
    { resultScope, navigation: "references" },
    manager,
  );
  expect(navigation.hits).toHaveLength(3);
  expect(navigation.hits.map((hit) => hit.source)).not.toContain(path.join(cwd, "other.ts"));
  expect(new Set(navigation.hits.map((hit) => hit.symbol.id)).size).toBe(1);
  expect(navigation.hits.filter((hit) => hit.role === "reference")).toHaveLength(2);
});

test("filters by full containment before limiting and reports incomplete navigation", async () => {
  const { cwd, manager, resultScope } = await fixture();
  const cut = {
    ...resultScope,
    targets: resultScope.targets.map((target) => ({
      ...target,
      ranges: [{ start: { lineNumber: 1, column: 7 }, end: { lineNumber: 1, column: 10 } }],
    })),
  };
  expect(
    await searchSymbols("same", cwd, 100, undefined, { resultScope: cut }, manager),
  ).toMatchObject({ hits: [], complete: true });
  const limited = await searchSymbols(
    "same",
    cwd,
    1,
    undefined,
    { resultScope, navigation: "references" },
    manager,
  );
  expect(limited.hits).toHaveLength(1);
  expect(limited.complete).toBe(false);
});

test("uses a reference inside the scope to seed navigation without mixing same-name symbols", async () => {
  const { cwd, manager, resultScope } = await fixture();
  const referenceScope = {
    ...resultScope,
    targets: resultScope.targets.map((target) => ({
      ...target,
      ranges: [{ start: { lineNumber: 2, column: 0 }, end: { lineNumber: 2, column: 4 } }],
    })),
  };
  const result = await searchSymbols(
    "same",
    cwd,
    100,
    undefined,
    { resultScope: referenceScope, navigation: "references" },
    manager,
  );
  expect(result.hits).toHaveLength(3);
  expect(result.hits.every((hit) => hit.symbol.source === path.join(cwd, "a.ts"))).toBe(true);
});

test("uses a provider selectionRange when workspace symbols span a whole declaration", async () => {
  const { cwd, manager, sendRequest } = await fixture();
  const source = "export function same() { same(); }\r\n";
  await writeFile(path.join(cwd, "a.ts"), source);
  const uri = pathToFileURL(path.join(cwd, "a.ts")).href;
  const declaration = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: source.trimEnd().length },
  };
  const name = { start: { line: 0, character: 16 }, end: { line: 0, character: 20 } };
  sendRequest.mockImplementation(async (method) => {
    if (method === "workspace/symbol")
      return [{ name: "same", kind: 12, location: { uri, range: declaration } }];
    if (method === "textDocument/documentSymbol")
      return [{ name: "same", kind: 12, range: declaration, selectionRange: name }];
    if (method === "textDocument/references") return [{ uri, range: name }];
    throw Error(`Unexpected request ${method}`);
  });
  const resultScope: ResolvedResultTargets = {
    complete: true,
    targets: [
      {
        source: path.join(cwd, "a.ts"),
        expectedContent: source,
        ranges: [{ start: { lineNumber: 1, column: 16 }, end: { lineNumber: 1, column: 20 } }],
      },
    ],
  };
  const result = await searchSymbols("same", cwd, 100, undefined, { resultScope }, manager);
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]).toMatchObject({
    role: "definition",
    startColumn: 16,
    endColumn: 20,
    matchedText: "same",
  });
  expect(sendRequest).toHaveBeenCalledWith(
    "textDocument/references",
    expect.objectContaining({ position: { line: 0, character: 16 } }),
    undefined,
  );
});
test("does not treat failed reference requests or missing providers as no matches", async () => {
  const { cwd, manager, sendRequest } = await fixture();
  sendRequest.mockImplementation(async (method) => {
    if (method === "workspace/symbol")
      return [
        {
          name: "same",
          kind: 12,
          location: {
            uri: pathToFileURL(path.join(cwd, "a.ts")).href,
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
          },
        },
      ];
    throw Error("reference request failed");
  });
  await expect(searchSymbols("same", cwd, 100, undefined, {}, manager)).rejects.toThrow(
    "reference request failed",
  );
  vi.mocked(manager.prepareWorkspaceSymbols).mockResolvedValue([]);
  await expect(searchSymbols("same", cwd, 100, undefined, {}, manager)).rejects.toThrow(
    /unavailable/iu,
  );
});

test("rejects stale source scopes and cancelled searches before creating targets", async () => {
  const { cwd, manager, resultScope } = await fixture();
  await writeFile(path.join(cwd, "a.ts"), "external edit\n");
  await expect(
    searchSymbols("same", cwd, 100, undefined, { resultScope }, manager),
  ).rejects.toThrow(/stale/iu);
  await expect(searchSymbols("same", cwd, 100, AbortSignal.abort(), {}, manager)).rejects.toThrow(
    /abort/iu,
  );
});
