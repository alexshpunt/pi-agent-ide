import { expect, test, vi } from "vitest";
import type { LspClient } from "./client.ts";
import { exactIdentifier, MAX_SCANNED_FILES, scanDeclarations } from "./declaration-scan.ts";
import type { LspCodeSymbol } from "./symbol-selectors.ts";

const range = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

function symbol(name: string, selectionRange = range(0, 0, name.length)): LspCodeSymbol {
  return { name, kind: 12, range: selectionRange, selectionRange, selector: [name], children: [] };
}

function fixture(files: readonly string[], texts: Record<string, string>) {
  const client = { hasWorkspaceSymbolCapability: true } as LspClient;
  const manager = {
    filesContainingInScope: vi.fn().mockResolvedValue(files),
    openFile: vi.fn(async (source: string) => ({
      client,
      uri: `file://${source}`,
      languageId: "go",
    })),
  };
  const input = {
    manager,
    cwd: "/workspace",
    roots: ["."],
    accepts: () => true,
    readText: async (source: string) => texts[source] ?? "",
  };
  return { client, manager, input };
}

test("only a plain identifier is an exact name", () => {
  expect(exactIdentifier("useRoleLabel")).toBe("useRoleLabel");
  expect(exactIdentifier("$value_2")).toBe("$value_2");
  expect(exactIdentifier("use role")).toBeUndefined();
  expect(exactIdentifier("Engine.Start")).toBeUndefined();
  expect(exactIdentifier("")).toBeUndefined();
});

test("a declaration is found by the identifier at its name range, whatever name the server gives", async () => {
  const { client, input } = fixture(["/workspace/a/engine.go"], {
    "/workspace/a/engine.go": "func (e *Engine) Start() {}\n",
  });
  const start = symbol("(*Engine).Start", range(0, 17, 22));
  const scan = await scanDeclarations({
    ...input,
    word: "Start",
    outlineOf: async () => [
      { ...symbol("Engine", range(0, 9, 15)), children: [start] },
      symbol("Stop", range(0, 0, 4)),
    ],
  });
  expect(scan.coverage).toBeUndefined();
  expect(scan.declarations.get(client)).toEqual([
    {
      name: "(*Engine).Start",
      kind: 12,
      location: { uri: "file:///workspace/a/engine.go", range: range(0, 17, 22) },
    },
  ]);
});

test("files past the limit and an owner that cannot list files make the scan incomplete", async () => {
  const files = Array.from({ length: MAX_SCANNED_FILES + 2 }, (_, index) => `/w/f${index}.go`);
  const { input, manager } = fixture(files, {});
  const scan = await scanDeclarations({ ...input, word: "x", outlineOf: async () => [] });
  expect(manager.openFile).toHaveBeenCalledTimes(MAX_SCANNED_FILES);
  expect(scan.coverage?.unopened).toEqual([...files].sort().slice(MAX_SCANNED_FILES));
  manager.filesContainingInScope.mockResolvedValue(undefined);
  const unlisted = await scanDeclarations({ ...input, word: "x", outlineOf: async () => [] });
  expect(unlisted.coverage).toMatchObject({ unlisted: true, unopened: [] });
});

test("a file of a server without document symbols leaves the workspace index as its only source", async () => {
  const { input } = fixture(["/workspace/a.go"], { "/workspace/a.go": "x" });
  const scan = await scanDeclarations({
    ...input,
    word: "x",
    outlineOf: () => Promise.reject(Object.assign(new Error("not found"), { code: -32601 })),
  });
  expect(scan.declarations.size).toBe(0);
  expect(scan.coverage).toBeUndefined();
});
