import { afterEach, expect, test, vi } from "vitest";
import { createDeclarationTargets } from "./declaration-targets.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient } from "./lsp/client.ts";
import { LspManager } from "./lsp/manager.ts";
import { LspServerRegistry } from "./lsp/registry.ts";
import type { LspDocumentSymbol } from "./lsp/symbols.ts";

const workspaces: string[] = [];
afterEach(async () => {
  await LspManager.resetForTest();
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

async function symbolFixture(nested = false) {
  const cwd = await mkdtemp(path.join(tmpdir(), "rename-guidance-"));
  workspaces.push(cwd);
  const file = path.join(cwd, "task.ts");
  const original = "export const count = 1;\n";
  await writeFile(file, original);
  const uri = pathToFileURL(file).href;
  const client = new LspClient({
    serverId: "fixture",
    rootUri: pathToFileURL(cwd).href,
    command: ["fixture"],
  });
  vi.spyOn(client, "documentContent").mockReturnValue(original);
  const symbol = (name: string, children?: LspDocumentSymbol[]): LspDocumentSymbol => ({
    name,
    kind: 14,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 23 } },
    selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } },
    ...(children && { children }),
  });
  const symbols = [
    nested ? symbol("Counter", [symbol("count")]) : symbol("count"),
    symbol("count#part"),
  ];
  const request = vi.spyOn(client, "sendRequest").mockResolvedValue(symbols);
  const manager = LspManager.init(LspServerRegistry.fromConfig({ version: 1, servers: {} }, cwd));
  vi.spyOn(manager, "openFile").mockResolvedValue({ client, uri, languageId: "typescript" });
  return { cwd, file, original, request, resolver: createDeclarationTargets(async () => manager) };
}

for (const selector of ["count", "Counter/count", "count%23part"]) {
  test(`a refused extra suffix on ${selector} provides a usable rename path without editing`, async () => {
    const { cwd, file, original, resolver } = await symbolFixture(selector.includes("/"));
    const result = await resolver.tryResolve(`symbol:task.ts#${selector}#total`, { cwd });
    expect(result).toMatchObject({ kind: "rejected", rejection: { code: "invalid" } });
    expect(result.kind === "rejected" && result.rejection.reason).toContain(
      `symbol:task.ts#${selector}#name`,
    );
    expect(await readFile(file, "utf8")).toBe(original);
  });
}

for (const selector of ["missing#total", "count%23total"]) {
  test(`an unresolved selector ${selector} does not invent a rename target`, async () => {
    const { cwd, resolver } = await symbolFixture();
    const result = await resolver.tryResolve(`symbol:task.ts#${selector}`, { cwd });
    expect(result).toMatchObject({ kind: "rejected", rejection: { code: "invalid" } });
    expect(result.kind === "rejected" && result.rejection.reason).not.toContain("#name");
  });
}

test("an actual declaration with a hash in its name remains a declaration target", async () => {
  const { cwd, request, resolver } = await symbolFixture();
  expect(await resolver.tryResolve("symbol:task.ts#count#part", { cwd })).toMatchObject({
    kind: "resolved",
  });
  expect(request).toHaveBeenCalledTimes(1);
});

test("cancellation during the candidate lookup remains a failure", async () => {
  const { cwd, request, resolver } = await symbolFixture();
  const controller = new AbortController();
  request
    .mockImplementationOnce(async () => [])
    .mockImplementationOnce(async () => {
      controller.abort(new Error("caller stopped"));
      throw controller.signal.reason;
    });
  expect(
    await resolver.tryResolve("symbol:task.ts#count#total", { cwd, signal: controller.signal }),
  ).toMatchObject({ kind: "failed" });
});

test("declaration text resolution leaves symbol name resources to semantic rename", async () => {
  const managerFor = vi.fn(async () => {
    throw new Error("Declaration resolution must not run for a rename resource");
  });
  const resolver = createDeclarationTargets(managerFor);
  for (const source of ["symbol:task.ts#count#name", "symbol:task.ts#Counter/count#name"]) {
    expect(await resolver.tryResolve(source, { cwd: process.cwd() })).toEqual({
      kind: "not-handled",
    });
  }
  expect(managerFor).not.toHaveBeenCalled();
});

test("a declaration that cannot resolve tells the agent why", async () => {
  const startup = "[lsp] rust-analyzer exited during startup with code 1: error: Unknown binary";
  const resolver = createDeclarationTargets(async () => {
    throw new Error(startup);
  });
  const result = await resolver.tryResolve("symbol:main.rs#run", { cwd: process.cwd() });
  expect(result).toMatchObject({ kind: "rejected", rejection: { code: "invalid" } });
  expect(result.kind === "rejected" && result.rejection.reason).toContain(startup);

  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  expect(
    await resolver.tryResolve("symbol:main.rs#run", {
      cwd: process.cwd(),
      signal: controller.signal,
    }),
  ).toMatchObject({ kind: "failed" });
});
