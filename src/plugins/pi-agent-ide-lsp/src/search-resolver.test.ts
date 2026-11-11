import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SearchRequest, SearchSelectionRegistration } from "pi-agent-search/api/search";
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

test("reads symbol and file call graphs as text without selections", async () => {
  backend.readLspSymbolGraph.mockResolvedValue("## graph: App/start");
  backend.readLspFileGraph.mockResolvedValue("## file graph: app.ts");

  const symbol = await resolver.tryResolve(request({ calls: "app.ts#App/start" }), { cwd });
  const file = await resolver.tryResolve(request({ calls: "app.ts" }), { cwd });

  expect(backend.readLspSymbolGraph).toHaveBeenCalledWith(
    manager,
    path.join(cwd, "app.ts"),
    ["App", "start"],
    cwd,
    undefined,
  );
  expect(backend.readLspFileGraph).toHaveBeenCalledWith(
    manager,
    path.join(cwd, "app.ts"),
    cwd,
    undefined,
  );
  expect(registered).toBeUndefined();
  if (symbol.kind !== "resolved" || file.kind !== "resolved") throw Error("calls failed");
  expect(resolver.toScriptData?.(symbol.payload, {})).toEqual({
    kind: "custom",
    resolverId: "lsp",
    value: { calls: "## graph: App/start" },
  });
});

test("follows references only when requested", async () => {
  backend.searchSymbols.mockResolvedValue({ hits: [], complete: true });

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
      return { hits: [], complete: true };
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
    .mockResolvedValueOnce({ hits: [hit(1)], complete: true })
    .mockResolvedValueOnce({ hits: [hit(2)], complete: true });
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

test("names the fatal compiler errors that can hide references", async () => {
  const coverage = {
    fatal: [{ source: path.join(cwd, "src/main.cpp"), line: 3, message: "'x.h' file not found" }],
    unchecked: 2,
    unlisted: false,
  };
  backend.searchSymbols.mockResolvedValue({ hits: [], complete: false, coverage });

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
