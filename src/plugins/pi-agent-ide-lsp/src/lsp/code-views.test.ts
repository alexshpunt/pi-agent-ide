import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { LspClient } from "./client.ts";
import { readLspFileGraph, readLspSymbolGraph } from "./code-views.ts";
import { LspManager } from "./manager.ts";
import { LspServerRegistry } from "./registry.ts";

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

test("a call graph asks at the position of the text the server holds while another session writes the file", async () => {
  const file = await writtenFile();

  const graph = await readLspSymbolGraph(file.manager, "a.cpp", ["handle"], file.cwd);

  // Every line is a line of the file as it is now, though the server answered for an older text.
  const [handle, helper, first, second] = await Promise.all(
    ["handle", "helper", "first", "second"].map((name) => file.lineOf(name)),
  );
  expect(graph).toContain(`Definition: a.cpp ${String(handle)} (Function)`);
  expect(graph).toContain(
    [
      "References: 3 in 1 file(s)",
      "- a.cpp (3)",
      `  - ${String(handle)}`,
      `  - ${String(first)}`,
      `  - ${String(second)}`,
    ].join("\n"),
  );
  expect(graph).toContain(
    [
      "Incoming calls: 2",
      `- Function first — a.cpp ${String(first)}`,
      `- Function second — a.cpp ${String(second)}`,
    ].join("\n"),
  );
  expect(graph).toContain(
    ["Outgoing calls: 1", `- Function helper — a.cpp ${String(helper)}`].join("\n"),
  );
  expect(file.writes()).toBeGreaterThan(1);
});

test("a file graph lists every relation while another session writes the file", async () => {
  const file = await writtenFile();

  const graph = await readLspFileGraph(file.manager, "a.cpp", file.cwd);

  // The peer writes again while the graph runs, so its lines are those of one text of the file:
  // the four declarations on consecutive lines, as in every text the peer writes.
  const definitions = [...graph.matchAll(/^Definition: (\d+)$/gmu)].map((hit) => Number(hit[1]));
  const first = definitions[0] ?? 0;
  expect(definitions).toEqual([first, first + 1, first + 2, first + 3]);
  expect(first).toBeGreaterThan(1);
  expect(graph).toContain(
    [
      "### Function handle",
      "Selector: handle",
      `Definition: ${String(first + 1)}`,
      "Used by: a.cpp (3)",
      "Incoming calls: first (a.cpp), second (a.cpp)",
      "Outgoing calls: helper (a.cpp)",
    ].join("\n"),
  );
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
  expect(graph).toContain(`Definition: a.cpp ${String(await file.lineOf("handle"))} (Function)`);
  expect(graph).toContain("References: 3 in 1 file(s)");
  expect(graph).toContain("Incoming calls: 2");
});
