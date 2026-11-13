import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import type { SearchRequest, SearchSelectionRegistration } from "pi-agent-search/api/search";
import { SearchSessionStore } from "pi-agent-search-text/search-session";
import { LspClient } from "./lsp/client.ts";
import { coverageNotes } from "./lsp/clang-coverage.ts";
import { LspManager } from "./lsp/manager.ts";
import { LspServerRegistry } from "./lsp/registry.ts";
import { createLspSearchResolver, type LspSearchBackend } from "./search-resolver.ts";

const cwd = path.resolve("/workspace");
const manager = LspManager.init(LspServerRegistry.fromConfig({ version: 1, servers: {} }, cwd));
const backend = {
  resolveLspDeclaration: vi.fn<LspSearchBackend["resolveLspDeclaration"]>(),
  readLspFileGraph: vi.fn<LspSearchBackend["readLspFileGraph"]>(),
  readLspSymbolGraph: vi.fn<LspSearchBackend["readLspSymbolGraph"]>(),
  searchSymbols: vi.fn<LspSearchBackend["searchSymbols"]>(),
};
let registered: SearchSelectionRegistration | undefined;
const resolver = createLspSearchResolver(
  async () => manager,
  async (selection) => {
    registered = selection;
    return { id: "LSP1", matches: selection.matches, complete: selection.complete };
  },
  backend,
);
const request = (
  lsp: Record<string, unknown>,
  extra: Partial<SearchRequest> = {},
): SearchRequest => ({
  query: "label",
  options: { lsp },
  ...extra,
});

afterEach(async () => {
  // Also drops queued answers a test did not consume, so they cannot reach the next test.
  vi.resetAllMocks();
  registered = undefined;
});

test("leaves requests without lsp options to other resolvers", async () => {
  await expect(resolver.tryResolve({ query: "label" }, { cwd })).resolves.toEqual({
    kind: "not-handled",
  });
});

test("rejects requests that combine or omit modes", async () => {
  for (const lsp of [{}, { query: "a", calls: "a.ts" }]) {
    const result = await resolver.tryResolve(request(lsp), { cwd });
    expect(result.kind).toBe("failed");
  }
});

test("returns a declaration as an exact selection that refreshes from the server", async () => {
  const source = path.join(cwd, "app.ts");
  const content = "const a = 1;\r\nclass App {\r\n  start() {}\r\n}\r\n";
  backend.resolveLspDeclaration.mockResolvedValue({
    source,
    content,
    range: { start: { line: 1, character: 0 }, end: { line: 3, character: 1 } },
  });

  const result = await resolver.tryResolve(request({ declaration: "app.ts#App" }), { cwd });

  expect(result.kind).toBe("resolved");
  expect(backend.resolveLspDeclaration).toHaveBeenCalledWith(
    manager,
    source,
    ["App"],
    cwd,
    undefined,
  );
  expect(registered?.matches).toEqual([
    {
      source,
      lineNumber: 2,
      startColumn: 0,
      endLineNumber: 5,
      endColumn: 0,
      matchedText: "class App {\r\n  start() {}\r\n}\r\n",
      lineText: "class App {",
    },
  ]);
  if (result.kind !== "resolved") return;
  const formatted = await resolver.format(result.payload, { cwd });
  const text = formatted.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  expect(text).toContain("SEARCH#LSP1:1:match app.ts:2-4 declaration app.ts#App");
  expect(text).toContain("  start() {}");
  await expect(registered?.refresh()).resolves.toMatchObject({ complete: true });
  expect(backend.resolveLspDeclaration).toHaveBeenCalledTimes(2);
});

test("ends a declaration on the last line of a file without a final line break", async () => {
  const source = path.join(cwd, "tail.ts");
  backend.resolveLspDeclaration.mockResolvedValue({
    source,
    content: "const a = 1;\nexport function tail() {}",
    range: { start: { line: 1, character: 7 }, end: { line: 1, character: 25 } },
  });

  await resolver.tryResolve(request({ declaration: "tail.ts#tail" }), { cwd });

  expect(registered?.matches).toEqual([
    {
      source,
      lineNumber: 2,
      startColumn: 0,
      endColumn: 25,
      matchedText: "export function tail() {}",
      lineText: "export function tail() {}",
    },
  ]);
});

test("requires a selector for declarations", async () => {
  await expect(resolver.tryResolve(request({ declaration: "app.ts" }), { cwd })).rejects.toThrow(
    "declaration requires file#selector",
  );
});

test("registers a call graph's references, callers and callees as selections", async () => {
  const source = path.join(cwd, "app.ts");
  const content = [
    "function save() {",
    "  validate();",
    "}",
    "function submit() {",
    "  save();",
    "}",
    "function validate() {}",
    "",
  ].join("\n");
  const range = (line: number, from: number, endLine: number, to: number) => ({
    start: { line, character: from },
    end: { line: endLine, character: to },
  });
  const graph = {
    text: "## graph: save",
    references: [
      { source, range: range(0, 9, 0, 13) },
      { source, range: range(4, 2, 4, 6) },
    ],
    incoming: [{ source, range: range(3, 0, 5, 1) }],
    outgoing: [{ source, range: range(6, 0, 6, 22) }],
    complete: true,
    contents: new Map([[source, content]]),
  };
  backend.readLspSymbolGraph.mockResolvedValue(graph);
  backend.readLspFileGraph.mockResolvedValue(graph);
  const selections: SearchSelectionRegistration[] = [];
  const graphs = createLspSearchResolver(
    async () => manager,
    async (selection) => {
      selections.push(selection);
      const list = `RESULT#list-${String(selections.length)}`;
      return {
        id: `LSP${String(selections.length)}`,
        target: list,
        matchTargets: selection.matches.map((_, index) => `${list}-${String(index)}`),
        matches: selection.matches,
        complete: selection.complete,
      };
    },
    backend,
  );

  const symbol = await graphs.tryResolve(request({ calls: "app.ts#save" }), { cwd });

  expect(backend.readLspSymbolGraph).toHaveBeenCalledWith(
    manager,
    source,
    ["save"],
    cwd,
    undefined,
  );
  // References exactly; each caller and callee as its whole declaration.
  expect(
    selections.map((selection) => selection.matches.map((match) => match.matchedText)),
  ).toEqual([
    ["save", "save"],
    ["function submit() {\n  save();\n}\n"],
    ["function validate() {}\n"],
  ]);
  if (symbol.kind !== "resolved") throw Error("calls failed");
  expect(graphs.toScriptData?.(symbol.payload, {})).toMatchObject({
    kind: "custom",
    resolverId: "lsp",
    value: {
      target: "RESULT#list-1",
      complete: true,
      matches: { matches: [{ target: "RESULT#list-1-0" }, { target: "RESULT#list-1-1" }] },
      incoming: { matches: [{ target: "RESULT#list-2-0", range: { startLine: 4 } }] },
      outgoing: { matches: [{ target: "RESULT#list-3-0", range: { startLine: 7 } }] },
    },
  });
  // A direct call still shows the graph text.
  const formatted = await graphs.format(symbol.payload, { cwd });
  expect(formatted.content).toEqual([{ type: "text", text: "## graph: save" }]);
  // A refresh takes the graph again and keeps each list to its own places.
  await expect(selections[1]?.refresh()).resolves.toMatchObject({
    matches: [{ matchedText: "function submit() {\n  save();\n}\n" }],
  });
  expect(backend.readLspSymbolGraph).toHaveBeenCalledTimes(2);

  await graphs.tryResolve(request({ calls: "app.ts" }), { cwd });
  expect(backend.readLspFileGraph).toHaveBeenCalledWith(manager, source, cwd, undefined);
});

test("follows references only when requested", async () => {
  backend.searchSymbols.mockResolvedValue({ hits: [], contents: new Map(), complete: true });

  await resolver.tryResolve(request({ query: "label" }, { path: "src" }), { cwd });
  await resolver.tryResolve(request({ query: "label", references: true }, { path: "src" }), {
    cwd,
  });

  const scopes: unknown[] = backend.searchSymbols.mock.calls.map((call) => call[4]);
  expect(scopes).toEqual([{ path: "src" }, { path: "src", navigation: "references" }]);
});

test("a result-scoped symbol search survives a write to its file while the server answers", async () => {
  await mkdir(".tmp/lsp-search-resolver", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/lsp-search-resolver/case-"));
  try {
    const source = path.join(directory, "app.ts");
    const content = "const label = 1;\n";
    await writeFile(source, content);
    const scope = {
      complete: true,
      targets: [
        {
          source,
          expectedContent: content,
          ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 16 } }],
        },
      ],
    };
    backend.searchSymbols.mockImplementation(async () => {
      // Another session writes elsewhere in the file before the server's answer arrives.
      await writeFile(source, `// peer\n${content}`);
      return { hits: [], contents: new Map(), complete: true };
    });

    const result = await resolver.tryResolve(request({ query: "label" }), { cwd, scope });

    expect(result.kind).toBe("resolved");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A search session that refuses the first registration, like a file written in between. */
function resolverWithOneChangedRegistration() {
  const sessions: SearchSelectionRegistration[] = [];
  let refused = false;
  const changing = createLspSearchResolver(
    async () => manager,
    async (selection) => {
      if (!refused) {
        refused = true;
        throw Object.assign(
          new Error(
            "Search result in /workspace/app.ts changed before its anchors were registered.",
          ),
          { name: "SearchSnapshotChangedError" },
        );
      }
      sessions.push(selection);
      return { id: "LSP2", matches: selection.matches, complete: selection.complete };
    },
    backend,
  );
  return { changing, sessions };
}

test("searches again when the file changes before a symbol search registers its anchors", async () => {
  const source = path.join(cwd, "app.ts");
  const hit = (lineNumber: number) => ({
    source,
    lineNumber,
    startColumn: 6,
    endColumn: 11,
    matchedText: "label",
    lineText: "const label = 1;",
    role: "definition" as const,
    symbol: {
      id: "label",
      name: "label",
      kind: "variable",
      source,
      range: { startLine: lineNumber, startColumn: 6, endLine: lineNumber, endColumn: 11 },
    },
  });
  backend.searchSymbols
    .mockResolvedValueOnce({ hits: [hit(1)], contents: new Map(), complete: true })
    .mockResolvedValueOnce({ hits: [hit(2)], contents: new Map(), complete: true });
  const { changing, sessions } = resolverWithOneChangedRegistration();

  const result = await changing.tryResolve(request({ query: "label" }), { cwd });

  expect(result.kind).toBe("resolved");
  expect(backend.searchSymbols).toHaveBeenCalledTimes(2);
  expect(sessions.map((session) => session.matches)).toEqual([[hit(2)]]);
});

test("resolves a declaration again when the file changes before its anchor is registered", async () => {
  const source = path.join(cwd, "app.ts");
  backend.resolveLspDeclaration
    .mockResolvedValueOnce({
      source,
      content: "class App {}\n",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
    })
    .mockResolvedValueOnce({
      source,
      content: "// peer\nclass App {}\n",
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 12 } },
    });
  const { changing, sessions } = resolverWithOneChangedRegistration();

  const result = await changing.tryResolve(request({ declaration: "app.ts#App" }), { cwd });

  expect(result.kind).toBe("resolved");
  expect(sessions[0]?.matches).toMatchObject([{ lineNumber: 2, matchedText: "class App {}\n" }]);
});

test("a declaration anchor registers from the text the declaration was found in while another session writes the file", async () => {
  await mkdir(".tmp/lsp-search-resolver", { recursive: true });
  const workspace = await mkdtemp(path.resolve(".tmp/lsp-search-resolver/declaration-"));
  onTestFinished(() => rm(workspace, { recursive: true, force: true }));
  const source = path.join(workspace, "app.ts");
  const content = "const a = 1;\nclass App {}\n";
  await writeFile(source, content);
  // The server finds the declaration in the file as it is when asked.
  backend.resolveLspDeclaration.mockImplementation(async () => {
    const found = await readFile(source, "utf8");
    const line = found.split("\n").indexOf("class App {}");
    return {
      source,
      content: found,
      range: { start: { line, character: 0 }, end: { line, character: 12 } },
    };
  });
  const targets = new ResultTargetStore();
  const sessions = new SearchSessionStore(undefined, targets, (file) => readFile(file, "utf8"));
  let writes = 0;
  let selected: SearchSelectionRegistration | undefined;
  const resolving = createLspSearchResolver(
    async () => manager,
    async (selection, context) => {
      // Another session inserts a line at the top of the file after the server answered and
      // before the anchor registers; the declaration keeps its text and only moves down.
      writes += 1;
      await writeFile(source, `${"// peer\n".repeat(writes)}${content}`);
      selected = selection;
      return sessions.register(
        selection.request.query,
        selection.matches,
        selection.complete,
        context.cwd,
        context.signal,
        selection.request,
        selection.refresh,
        undefined,
        context.environment,
        selection.contents,
      );
    },
    backend,
  );

  const result = await resolving.tryResolve(request({ declaration: "app.ts#App" }), {
    cwd: workspace,
  });

  if (result.kind !== "resolved") throw Error("declaration failed");
  // One server lookup and one registration: no second read of the file disagreed with it.
  expect(backend.resolveLspDeclaration).toHaveBeenCalledTimes(1);
  expect(writes).toBe(1);
  const data = resolving.toScriptData?.(result.payload, {}) as {
    matches: { target?: string; matchedText?: string }[];
  };
  expect(data.matches.map((match) => match.matchedText)).toEqual(["class App {}\n"]);
  // The anchor describes the file as it is now, with the declaration where the writer moved it.
  const anchored = targets.resolve(data.matches[0]?.target, workspace);
  expect(anchored.targets[0]?.expectedContent).toBe(await readFile(source, "utf8"));
  expect(anchored.targets[0]?.ranges).toEqual([
    { start: { lineNumber: 3, column: 0 }, end: { lineNumber: 4, column: 0 } },
  ]);
  await targets.verify(anchored);
  // A refresh also returns the text it found the declaration in.
  const refreshed = await selected?.refresh();
  expect(refreshed?.contents?.get(source)).toBe(await readFile(source, "utf8"));
  expect(refreshed?.matches.map((match) => match.lineNumber)).toEqual([3]);
});

test("symbol anchors register from the text the hits were mapped onto while another session writes the file", async () => {
  await mkdir(".tmp/lsp-search-resolver", { recursive: true });
  const workspace = await mkdtemp(path.resolve(".tmp/lsp-search-resolver/writer-"));
  onTestFinished(async () => {
    await LspManager.resetForTest();
    await rm(workspace, { recursive: true, force: true });
  });
  const source = path.join(workspace, "app.ts");
  const content = "const label = 1;\nlabel;\n";
  await writeFile(source, content);
  const uri = pathToFileURL(source).href;
  // The server answers for the file as it is when asked, below the lines the writer inserted.
  const at = async (line: number, from: number, to: number) => {
    const shift = (await readFile(source, "utf8")).split("\n").indexOf("const label = 1;");
    return {
      uri,
      range: {
        start: { line: line + shift, character: from },
        end: { line: line + shift, character: to },
      },
    };
  };
  const client = new LspClient({
    serverId: "fixture",
    rootUri: pathToFileURL(workspace).href,
    command: ["fixture"],
  });
  vi.spyOn(client, "sendRequest").mockImplementation(async (method) => {
    if (method === "workspace/symbol")
      return [{ name: "label", kind: 13, location: await at(0, 6, 11) }];
    if (method === "textDocument/documentSymbol") return [];
    if (method === "textDocument/references") return [await at(0, 6, 11), await at(1, 0, 5)];
    throw Error(`Unexpected request ${method}`);
  });
  const lsp = LspManager.init(LspServerRegistry.fromConfig({ version: 1, servers: {} }, workspace));
  const searches = vi.spyOn(lsp, "prepareWorkspaceSymbols").mockResolvedValue([client]);
  vi.spyOn(lsp, "openFile").mockResolvedValue({ client, uri, languageId: "typescript" });
  const targets = new ResultTargetStore();
  const sessions = new SearchSessionStore(undefined, targets, (file) => readFile(file, "utf8"));
  let writes = 0;
  let selected: SearchSelectionRegistration | undefined;
  const searching = createLspSearchResolver(
    async () => lsp,
    async (selection, context) => {
      // Another session inserts a line at the top of the file after the server answered and
      // before the anchors register; the lines of the hits keep their text and only move down.
      writes += 1;
      await writeFile(source, `${"// peer\n".repeat(writes)}${content}`);
      selected = selection;
      return sessions.register(
        selection.request.query,
        selection.matches,
        selection.complete,
        context.cwd,
        context.signal,
        selection.request,
        selection.refresh,
        undefined,
        context.environment,
        selection.contents,
      );
    },
  );

  const result = await searching.tryResolve(request({ query: "label" }), { cwd: workspace });

  if (result.kind !== "resolved") throw Error("search failed");
  const data = searching.toScriptData?.(result.payload, {}) as {
    target?: string;
    matches: { target?: string; matchedText?: string; range: { startLine: number } }[];
  };
  expect(data.matches.map((match) => [match.range.startLine, match.matchedText])).toEqual([
    [1, "label"],
    [2, "label"],
  ]);
  // One server search and one registration: no second read of the file disagreed with the hits.
  expect(searches).toHaveBeenCalledTimes(1);
  expect(writes).toBe(1);
  // The anchors describe the file as it is now, with the hits where the writer moved them.
  const current = await readFile(source, "utf8");
  const ranges = [
    { start: { lineNumber: 2, column: 6 }, end: { lineNumber: 2, column: 11 } },
    { start: { lineNumber: 3, column: 0 }, end: { lineNumber: 3, column: 5 } },
  ];
  for (const [index, match] of data.matches.entries()) {
    const anchored = targets.resolve(match.target, workspace);
    expect(anchored.targets[0]?.expectedContent).toBe(current);
    expect(anchored.targets[0]?.ranges).toEqual([ranges[index]]);
    await targets.verify(anchored);
  }
  const all = targets.resolve(data.target, workspace);
  expect(all.targets[0]?.ranges).toEqual(ranges);
  await targets.verify(all);
  // A refresh, such as for an all-anchor after other edits, also returns the text its hits
  // were mapped onto, so it needs no second read either.
  const refreshed = await selected?.refresh();
  expect(refreshed?.contents?.get(source)).toBe(current);
  expect(refreshed?.matches.map((match) => match.lineNumber)).toEqual([2, 3]);
});

test("names the fatal compiler errors that can hide references", async () => {
  const coverage = {
    fatal: [{ source: path.join(cwd, "src/main.cpp"), line: 3, message: "'x.h' file not found" }],
    unchecked: 2,
    unlisted: false,
  };
  backend.searchSymbols.mockResolvedValue({
    hits: [],
    contents: new Map(),
    complete: false,
    coverage,
  });

  const result = await resolver.tryResolve(request({ query: "label" }), { cwd });

  if (result.kind !== "resolved") throw Error("search failed");
  const formatted = await resolver.format(result.payload, { cwd });
  const text = formatted.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  for (const note of coverageNotes(coverage, (source) => path.relative(cwd, source)))
    expect(text).toContain(note);
  expect(text).toContain(`${path.join("src", "main.cpp")}:3 'x.h' file not found`);
  expect(registered?.complete).toBe(false);
  await expect(registered?.refresh()).resolves.toMatchObject({ complete: false });
});
