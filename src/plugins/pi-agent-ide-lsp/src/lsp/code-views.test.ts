import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { LspClient } from "./client.ts";
import {
  readLspFileGraph,
  readLspSymbolGraph,
  resolveLspDeclaration,
  type LspGraphLocation,
} from "./code-views.ts";
import { LspManager } from "./manager.ts";
import { LspServerRegistry } from "./registry.ts";
import { SymbolNotFoundError } from "./symbol-selectors.ts";

import type { LspRange } from "./types.ts";

const workspaces: string[] = [];
afterEach(async () => {
  await LspManager.resetForTest();
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

const original = [
  "int helper(int value) { return value * 2; }",
  "int handle(int value) { return helper(value) + 1; }",
  "int first() { return handle(1); }",
  "int second() { return handle(2); }",
  "",
].join("\n");

/**
 * A C++ server over one file that another session keeps writing. Each write inserts a line at the
 * top, so existing lines keep their text and only their numbers move. The server answers for the
 * text it holds, which every open of the file replaces with the text on disk.
 */
async function writtenFile() {
  await mkdir(".tmp/code-views", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/code-views/case-"));
  workspaces.push(cwd);
  const source = path.join(cwd, "a.cpp");
  const uri = pathToFileURL(source).href;
  await writeFile(source, original);
  let writes = 0;
  const peerWrites = async () => {
    writes += 1;
    await writeFile(source, `// peer ${String(writes)}\n${await readFile(source, "utf8")}`);
  };
  let served = original;
  const client = new LspClient({
    serverId: "fixture",
    rootUri: pathToFileURL(cwd).href,
    command: ["fixture"],
  });
  vi.spyOn(client, "documentContent").mockImplementation((target) =>
    target === uri ? served : undefined,
  );
  const lines = () => served.split("\n");
  const declared = (name: string): LspRange => {
    const line = lines().findIndex((row) => row.startsWith(`int ${name}(`));
    return { start: { line, character: 4 }, end: { line, character: 4 + name.length } };
  };
  const item = (name: string) => ({
    name,
    kind: 12,
    uri,
    range: declared(name),
    selectionRange: declared(name),
  });
  const callsOf = (name: string, caller?: string): LspRange[] =>
    lines().flatMap((row, line) => {
      if (caller !== undefined && !row.startsWith(`int ${caller}(`)) return [];
      const character = row.indexOf(`${name}(`, caller === undefined ? 0 : 5);
      return character === -1
        ? []
        : [{ start: { line, character }, end: { line, character: character + name.length } }];
    });
  /** The function whose name the position names in the server's text. */
  const named = (position: { line: number; character: number }) =>
    ["helper", "handle", "first", "second"].find(
      (name) =>
        lines()[position.line]?.slice(position.character, position.character + name.length) ===
        name,
    );
  const requests: string[] = [];
  const sendRequest = vi
    .spyOn(client, "sendRequest")
    .mockImplementation(async (method, parameters) => {
      requests.push(method);
      const input = parameters as {
        position?: { line: number; character: number };
        item?: { name: string };
      };
      switch (method) {
        case "textDocument/documentSymbol": {
          const symbols = ["helper", "handle", "first", "second"].map((name) => ({
            name,
            kind: 12,
            range: {
              start: { line: declared(name).start.line, character: 0 },
              end: declared(name).end,
            },
            selectionRange: declared(name),
          }));
          // The peer writes again right after the server listed the symbols.
          await peerWrites();
          return symbols;
        }
        case "textDocument/diagnostic": {
          return { kind: "full", items: [] };
        }
        case "textDocument/references": {
          return named(requiredPosition(input)) === "handle"
            ? callsOf("handle").map((range) => ({ uri, range }))
            : [];
        }
        case "textDocument/prepareCallHierarchy": {
          const name = named(requiredPosition(input));
          return name === undefined ? [] : [item(name)];
        }
        case "callHierarchy/incomingCalls": {
          if (input.item?.name !== "handle") return [];
          const answer = ["first", "second"].map((caller) => ({
            from: item(caller),
            fromRanges: callsOf("handle", caller),
          }));
          // A write that reaches the file but not yet the server, which still holds its text.
          await peerWrites();
          return answer;
        }
        case "callHierarchy/outgoingCalls": {
          return input.item?.name === "handle"
            ? [{ to: item("helper"), fromRanges: callsOf("helper", "handle") }]
            : [];
        }
        default: {
          throw Error(`Unexpected request ${method}`);
        }
      }
    });
  const manager = LspManager.init(LspServerRegistry.fromConfig({ version: 1, servers: {} }, cwd));
  /** Another open of the file publishes its text on disk to the server. */
  const reopen = async () => {
    served = await readFile(source, "utf8");
  };
  vi.spyOn(manager, "openFile").mockImplementation(async (file) => {
    const target = pathToFileURL(path.resolve(cwd, file)).href;
    if (target === uri) await reopen();
    return { client, uri: target, languageId: "cpp" };
  });
  vi.spyOn(manager, "filesContaining").mockResolvedValue([source]);
  /** 1-based line of each function in the file as it is now. */
  const lineOf = async (name: string) =>
    (await readFile(source, "utf8"))
      .split("\n")
      .findIndex((row) => row.startsWith(`int ${name}(`)) + 1;
  return {
    cwd,
    manager,
    sendRequest,
    requests,
    peerWrites,
    reopen,
    lineOf,
    writes: () => writes,
  };
}

function requiredPosition(input: { position?: { line: number; character: number } }) {
  if (input.position === undefined) throw Error("The request carries no position.");
  return input.position;
}

test.each([readLspSymbolGraph, resolveLspDeclaration])(
  "%s stops retrying when the server never confirms the overload",
  async (resolve) => {
    const file = await writtenFile();
    await expect(resolve(file.manager, "a.cpp", ["handle(float)"], file.cwd)).rejects.toMatchObject(
      {
        code: "LSP_SELECTOR_UNCONFIRMED",
      },
    );
    expect(file.requests).toEqual(Array.from({ length: 5 }, () => "textDocument/documentSymbol"));
  },
);

test.each([readLspSymbolGraph, resolveLspDeclaration])(
  "%s does not retry when the source contains only a substring of another identifier",
  async (resolve) => {
    const file = await writtenFile();
    await expect(resolve(file.manager, "a.cpp", ["hand"], file.cwd)).rejects.toBeInstanceOf(
      SymbolNotFoundError,
    );
    expect(file.requests).toEqual(["textDocument/documentSymbol"]);
  },
);

test.each([readLspSymbolGraph, resolveLspDeclaration])(
  "%s does not retry an ambiguous overload name",
  async (resolve) => {
    const file = await writtenFile();
    const range = { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } };
    file.sendRequest.mockResolvedValue([
      { name: "handle", kind: 12, range, selectionRange: range, detail: "int (int)" },
      { name: "handle", kind: 12, range, selectionRange: range, detail: "int (float)" },
    ]);
    await expect(resolve(file.manager, "a.cpp", ["handle"], file.cwd)).rejects.toBeInstanceOf(
      Error,
    );
    expect(file.sendRequest).toHaveBeenCalledTimes(1);
  },
);

test("a call graph asks at the position of the text the server holds while another session writes the file", async () => {
  const file = await writtenFile();

  const places = await readLspSymbolGraph(file.manager, "a.cpp", ["handle"], file.cwd);

  // Every line is a line of the file as it is now, though the server answered for an older text.
  const [handle, helper, first, second] = await Promise.all(
    ["handle", "helper", "first", "second"].map((name) => file.lineOf(name)),
  );
  const lines = (list: readonly LspGraphLocation[]) =>
    list.map((location) => location.range.start.line + 1);
  expect(lines(places.references)).toEqual([handle, first, second]);
  expect(lines(places.incoming)).toEqual([first, second]);
  expect(lines(places.outgoing)).toEqual([helper]);
  expect(places.complete).toBe(true);
  const text = places.contents.get(path.join(file.cwd, "a.cpp"))?.split("\n");
  expect(text?.[(first ?? 0) - 1]).toBe("int first() { return handle(1); }");
  expect(file.writes()).toBeGreaterThan(1);
});

test("a file graph lists every relation while another session writes the file", async () => {
  const file = await writtenFile();

  const places = await readLspFileGraph(file.manager, "a.cpp", file.cwd);

  // The peer writes again while the graph runs, so its lines are those of one text of the file:
  // the four declarations on consecutive lines, as in every text the peer writes.
  const source = places.contents.get(path.join(file.cwd, "a.cpp"));
  const first = (source ?? "").split("\n").findIndex((line) => line.startsWith("int helper(")) + 1;
  expect(first).toBeGreaterThan(1);
  // The places of every declaration merge into one list each.
  const lines = (list: readonly LspGraphLocation[]) =>
    list.map((location) => location.range.start.line + 1);
  expect(lines(places.references)).toEqual([first + 1, first + 2, first + 3]);
  expect(lines(places.incoming)).toEqual([first + 2, first + 3]);
  expect(lines(places.outgoing)).toEqual([first]);
});

test("an empty reference reply for a known function is retried", async () => {
  const file = await writtenFile();
  const answer = file.sendRequest.getMockImplementation();
  let asked = false;
  file.sendRequest.mockImplementation(async (method, parameters, signal) => {
    if (method === "textDocument/references" && !asked) {
      asked = true;
      return [];
    }
    return answer?.(method, parameters, signal);
  });

  const graph = await readLspSymbolGraph(file.manager, "a.cpp", ["handle"], file.cwd);

  expect(graph.references).toHaveLength(3);
  expect(graph.incoming).toHaveLength(2);
});

test("an unresolved call hierarchy keeps the references but marks the graph incomplete", async () => {
  const file = await writtenFile();
  const answer = file.sendRequest.getMockImplementation();
  file.sendRequest.mockImplementation(async (method, parameters, signal) =>
    method === "textDocument/prepareCallHierarchy" ? null : answer?.(method, parameters, signal),
  );

  const graph = await readLspSymbolGraph(file.manager, "a.cpp", ["handle"], file.cwd);

  expect(graph.complete).toBe(false);
  expect(graph.references).toHaveLength(3);
});

test("a call graph runs again when the server's text changes while it answers", async () => {
  const file = await writtenFile();
  const answer = file.sendRequest.getMockImplementation();
  let reopened = false;
  file.sendRequest.mockImplementation(async (method, parameters, signal) => {
    // The first references request finds the server's text replaced by another open of the file.
    if (method === "textDocument/references" && !reopened) {
      reopened = true;
      await file.peerWrites();
      await file.reopen();
    }
    return answer?.(method, parameters, signal);
  });

  const graph = await readLspSymbolGraph(file.manager, "a.cpp", ["handle"], file.cwd);

  expect(reopened).toBe(true);
  // The graph was taken again: a second document-symbol read follows the failed attempt.
  expect(file.requests.filter((method) => method === "textDocument/documentSymbol")).toHaveLength(
    2,
  );
  const handle = await file.lineOf("handle");
  expect(graph.references.map(({ range }) => range.start.line + 1)).toContain(handle);
  expect(graph.references).toHaveLength(3);
  expect(graph.incoming).toHaveLength(2);
});
