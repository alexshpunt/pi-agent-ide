import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SearchRequest, SearchSelectionRegistration } from "pi-agent-search/api/search";
import { LspManager } from "./lsp/manager.js";
import { LspServerRegistry } from "./lsp/registry.js";
import { createLspSearchResolver, type LspSearchBackend } from "./search-resolver.js";

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
  vi.clearAllMocks();
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
      endLineNumber: 4,
      endColumn: 1,
      matchedText: "class App {\r\n  start() {}\r\n}",
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
