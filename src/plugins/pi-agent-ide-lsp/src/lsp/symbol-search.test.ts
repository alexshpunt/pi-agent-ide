import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import type { ResolvedResultTargets } from "pi-agent-resource";
import { requiredValue } from "pi-agent-invariant";
import { LspClient } from "./client.ts";
import { LspManager } from "./manager.ts";
import { LspServerRegistry } from "./registry.ts";
import { searchSymbols } from "./symbol-search.ts";

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
      if (method === "textDocument/documentSymbol") return [];
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
  return { cwd, manager, client, sendRequest, resultScope };
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
  expect(result).toEqual({ hits: [], contents: new Map(), complete: true });
  expect(manager.prepareWorkspaceSymbols).not.toHaveBeenCalled();
});

test("include globs keep comma-separated brace alternatives", async () => {
  const { cwd, manager } = await fixture();
  const all = await searchSymbols("same", cwd, 20, undefined, { path: "." }, manager);
  const braces = await searchSymbols(
    "same",
    cwd,
    20,
    undefined,
    { path: ".", include: "*.{ts,md}" },
    manager,
  );
  expect(all.hits.length).toBeGreaterThan(0);
  expect(braces.hits).toEqual(all.hits);
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

test("lists each overload with its selector when the symbol index lags behind the file", async () => {
  const { cwd, manager, sendRequest } = await fixture();
  const lines = [
    "int clamp(int v);",
    "int clamp(float v);",
    "int clamp(int v) { return v; }",
    "int clamp(float v) { return clamp(1); }",
  ];
  await writeFile(path.join(cwd, "a.ts"), `${lines.join("\n")}\n`);
  const uri = pathToFileURL(path.join(cwd, "a.ts")).href;
  const at = (line: number, from: number) => ({
    start: { line, character: from },
    end: { line, character: from + 5 },
  });
  const entry = (line: number, detail: string) => ({
    name: "clamp",
    kind: 12,
    detail,
    range: { start: { line, character: 0 }, end: { line, character: lines[line]?.length ?? 0 } },
    selectionRange: at(line, 4),
  });
  sendRequest.mockImplementation(async (method, parameters) => {
    // The index still has the definitions one column to the right of the current text.
    if (method === "workspace/symbol")
      return [
        { name: "clamp", kind: 12, location: { uri, range: at(2, 5) } },
        { name: "clamp", kind: 12, location: { uri, range: at(3, 5) } },
      ];
    if (method === "textDocument/documentSymbol")
      return [
        entry(0, "int (int)"),
        entry(1, "int (float)"),
        entry(2, "int (int)"),
        entry(3, "int (float)"),
      ];
    if (method === "textDocument/references") {
      const { line } = (parameters as { position: { line: number } }).position;
      return line % 2 === 0
        ? [at(0, 4), at(2, 4), at(3, 28)].map((range) => ({ uri, range }))
        : [at(1, 4), at(3, 4)].map((range) => ({ uri, range }));
    }
    throw Error(`Unexpected request ${method}`);
  });
  const result = await searchSymbols("clamp", cwd, 100, undefined, { path: "a.ts" }, manager);
  expect(
    result.hits.map((hit) => [hit.role, hit.lineNumber, hit.startColumn, hit.symbol.selector]),
  ).toEqual([
    ["reference", 1, 4, ["clamp(int)"]],
    ["reference", 2, 4, ["clamp(float)"]],
    ["definition", 3, 4, ["clamp(int)"]],
    ["definition", 4, 4, ["clamp(float)"]],
    ["reference", 4, 28, ["clamp(int)"]],
  ]);
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

test("a result scope follows a write elsewhere in its file before the server answers", async () => {
  const { cwd, manager, sendRequest, resultScope } = await fixture();
  const original = requiredValue(resultScope.targets[0]).expectedContent;
  // Another session inserts a line above the scope after it was resolved; the server already
  // answers for the new text.
  await writeFile(path.join(cwd, "a.ts"), `// peer\r\n${original}`);
  const next = sendRequest.getMockImplementation();
  sendRequest.mockImplementation(async (method, parameters) => {
    const answer: unknown = await next?.(method, parameters);
    return method === "workspace/symbol" || method === "textDocument/references"
      ? shiftedLocations(answer, path.join(cwd, "a.ts"))
      : answer;
  });

  const result = await searchSymbols("same", cwd, 100, undefined, { resultScope }, manager);

  expect(result.hits).toMatchObject([
    { lineNumber: 2, startColumn: 6, endColumn: 10, matchedText: "same", role: "definition" },
  ]);
});

test("a result scope follows a write elsewhere in its file while the server answers", async () => {
  const { cwd, manager, client, sendRequest, resultScope } = await fixture();
  const source = path.join(cwd, "a.ts");
  const original = requiredValue(resultScope.targets[0]).expectedContent;
  // The server synced the text the scope came from, then another session inserts a line above
  // the scope while the server answers.
  vi.spyOn(client, "documentContent").mockImplementation((uri) =>
    uri === pathToFileURL(source).href ? original : undefined,
  );
  const next = sendRequest.getMockImplementation();
  sendRequest.mockImplementation(async (method, parameters) => {
    if (method === "workspace/symbol") await writeFile(source, `// peer\r\n${original}`);
    return next?.(method, parameters);
  });

  const result = await searchSymbols("same", cwd, 100, undefined, { resultScope }, manager);

  expect(result.hits).toMatchObject([
    { lineNumber: 2, startColumn: 6, endColumn: 10, matchedText: "same", role: "definition" },
  ]);
});

/** Server locations in `source` one line further down, as an answer for a text with a new first line. */
function shiftedLocations(answer: unknown, source: string): unknown {
  if (!Array.isArray(answer)) return answer;
  const uri = pathToFileURL(source).href;
  const shift = (location: { uri: string; range: LspRange }) =>
    location.uri !== uri
      ? location
      : {
          ...location,
          range: {
            start: { ...location.range.start, line: location.range.start.line + 1 },
            end: { ...location.range.end, line: location.range.end.line + 1 },
          },
        };
  return answer.map((item: { uri?: string; location?: { uri: string; range: LspRange } }) =>
    item.location !== undefined
      ? { ...item, location: shift(item.location) }
      : shift(item as { uri: string; range: LspRange }),
  );
}
type LspRange = {
  start: { line: number; character: number };
  end: { line: number; character: number };
};

test("asks for references at the position of the text the server holds, not of the text the declaration was read from", async () => {
  const { cwd, manager, client, sendRequest } = await fixture();
  const source = path.join(cwd, "a.ts");
  const uri = pathToFileURL(source).href;
  const original = '"😀"; same();\r\nsame();\r\n';
  // Our own reads publish the file as it is now, so the server's text runs ahead of the text a
  // declaration was read from while another session keeps writing.
  let served = original;
  vi.spyOn(client, "documentContent").mockImplementation((target) =>
    target === uri ? served : undefined,
  );
  vi.mocked(manager.openFile).mockImplementation(async (file) => {
    const target = pathToFileURL(path.resolve(cwd, file)).href;
    if (target === uri) served = await readFile(source, "utf8");
    return { client, uri: target, languageId: "cpp" };
  });
  vi.spyOn(manager, "filesContaining").mockResolvedValue([source]);
  const name = {
    start: { line: 0, character: 6 },
    end: { line: 0, character: 10 },
  };
  const next = sendRequest.getMockImplementation();
  sendRequest.mockImplementation(async (method, parameters) => {
    const input = parameters as { textDocument?: { uri: string }; position?: { line: number } };
    if (method === "textDocument/documentSymbol" && input.textDocument?.uri === uri) {
      // Another session inserts a line above the declaration after it was read; the coverage
      // check's diagnostics read then publishes the new text to the server.
      await writeFile(source, `// peer\r\n${original}`);
      return [
        {
          name: "same",
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } },
          selectionRange: name,
        },
      ];
    }
    if (method === "textDocument/diagnostic") return { kind: "full", items: [] };
    if (method === "textDocument/references" && input.textDocument?.uri === uri)
      // The server answers for its own text: a position of the older text names another line.
      return input.position?.line === 1
        ? shiftedLocations(await next?.(method, parameters), source)
        : [];
    return next?.(method, parameters);
  });

  const result = await searchSymbols(
    "same",
    cwd,
    100,
    undefined,
    { path: "a.ts", navigation: "references" },
    manager,
  );

  expect(result.hits.map((hit) => [hit.role, path.basename(hit.source), hit.lineNumber])).toEqual([
    ["definition", "a.ts", 2],
    ["reference", "a.ts", 3],
    ["reference", "b.ts", 1],
  ]);
  expect(result.complete).toBe(true);
});

test("lists every reference when another session's write reaches the server while it answers", async () => {
  const { cwd, manager, client, sendRequest } = await fixture();
  const source = path.join(cwd, "a.ts");
  const uri = pathToFileURL(source).href;
  const original = '"😀"; same();\r\nsame();\r\n';
  const advanced = `// peer\r\n${original}`;
  let served = original;
  vi.spyOn(client, "documentContent").mockImplementation((target) =>
    target === uri ? served : undefined,
  );
  vi.mocked(manager.openFile).mockImplementation(async (file) => {
    const target = pathToFileURL(path.resolve(cwd, file)).href;
    if (target === uri) served = await readFile(source, "utf8");
    return { client, uri: target, languageId: "typescript" };
  });
  const next = sendRequest.getMockImplementation();
  // Every answer names the text the server holds: the file's own line moves down by one once
  // another session's write reaches it.
  const shift = () => (served === advanced ? 1 : 0);
  sendRequest.mockImplementation(async (method, parameters) => {
    const input = parameters as { textDocument?: { uri: string }; position?: { line: number } };
    if (input.textDocument?.uri !== uri && method !== "workspace/symbol")
      return next?.(method, parameters);
    if (method === "textDocument/documentSymbol")
      return shift() === 0
        ? []
        : [
            {
              name: "same",
              kind: 12,
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 13 } },
              selectionRange: {
                start: { line: 1, character: 6 },
                end: { line: 1, character: 10 },
              },
            },
          ];
    if (method === "textDocument/references") {
      // The write and our read of it land between the request and its answer.
      await writeFile(source, advanced);
      served = advanced;
      return input.position?.line === 1
        ? shiftedLocations(await next?.(method, parameters), source)
        : [];
    }
    const answer: unknown = await next?.(method, parameters);
    return shift() === 0 ? answer : shiftedLocations(answer, source);
  });

  const result = await searchSymbols(
    "same",
    cwd,
    100,
    undefined,
    { path: "a.ts", navigation: "references" },
    manager,
  );

  expect(result.hits.map((hit) => [hit.role, path.basename(hit.source), hit.lineNumber])).toEqual([
    ["definition", "a.ts", 2],
    ["reference", "a.ts", 3],
    ["reference", "b.ts", 1],
  ]);
  // Each hit describes the text returned for its file, the file as it is after the write, so its
  // anchors can register from that text without reading the file again.
  expect(result.contents.get(source)).toBe(advanced);
  expect(result.contents.get(path.join(cwd, "b.ts"))).toBe("same();\n");
  for (const hit of result.hits) {
    const line = requiredValue(result.contents.get(hit.source)).split(/\r?\n/u)[hit.lineNumber - 1];
    expect(line).toBe(hit.lineText);
    expect(line?.slice(hit.startColumn, hit.endColumn)).toBe(hit.matchedText);
  }
});

test("rejects a scope whose own text changed and cancelled searches before creating targets", async () => {
  const { cwd, manager, resultScope } = await fixture();
  await writeFile(path.join(cwd, "a.ts"), "external edit\n");
  await expect(
    searchSymbols("same", cwd, 100, undefined, { resultScope }, manager),
  ).rejects.toThrow(/no longer be found/iu);
  await expect(searchSymbols("same", cwd, 100, AbortSignal.abort(), {}, manager)).rejects.toThrow(
    /abort/iu,
  );
});
