import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URI } from "vscode-uri";
import { afterEach, expect, test, vi } from "vitest";

import { LspClient } from "./client.ts";
import { requestDiagnostics } from "./diagnostics.ts";
import { LspSharedServers } from "./shared-servers.ts";

const SERVER = path.resolve(
  "src/plugins/pi-agent-ide-lsp/src/lsp/test/fixtures/document-lifecycle-server.mjs",
);
const LINGER_MS = 300;

interface Status {
  readonly open: readonly string[];
  readonly events: readonly (readonly [string, string])[];
  readonly watched: readonly { readonly uri: string; readonly type: number }[];
  readonly pid: number;
}

const clients: LspClient[] = [];
const servers = new Set<number>();
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.allSettled(clients.splice(0).map((client) => client.shutdown()));
  // Shared servers outlive their sessions for the linger time.
  await Promise.all([...servers].map((pid) => until(() => !alive(pid))));
  servers.clear();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<{ cwd: string; sharing: LspSharedServers; sockets: string }> {
  const root = path.resolve(".agents/tmp/lsp-shared-servers");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  // Socket paths have a short length limit, so they live in the system temporary directory.
  const sockets = await mkdtemp(path.join(os.tmpdir(), "lsp-shared-"));
  directories.push(cwd, sockets);
  await writeFile(path.join(cwd, "first.fx"), "first\n");
  return { cwd, sharing: new LspSharedServers({ directory: sockets }), sockets };
}

async function session(
  cwd: string,
  sharing: LspSharedServers,
  settings: Record<string, unknown> = { fixture: { mode: "strict" } },
  lingerMs = LINGER_MS,
  env: Record<string, string> = {},
): Promise<LspClient> {
  const client = new LspClient({
    serverId: "fixture",
    rootUri: URI.file(cwd).toString(),
    command: [process.execPath, SERVER],
    env,
    settings,
    sharedServers: sharing,
    idleTimeoutMs: lingerMs,
  });
  clients.push(client);
  await client.start();
  if (client.pid !== null) servers.add(client.pid);
  return client;
}

const status = (client: LspClient) => client.sendRequest<Status>("lifecycle/status", {});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("sessions with the same configuration share one server; other settings get another", async () => {
  const { cwd, sharing } = await workspace();
  const first = await session(cwd, sharing);
  const second = await session(cwd, sharing);
  const other = await session(cwd, sharing, { fixture: { mode: "loose" } });

  expect(first.shared).toBe(true);
  expect(second.pid).toBe(first.pid);
  expect(other.pid).not.toBe(first.pid);
  expect((await status(second)).pid).toBe(first.pid);
  expect(first.diagnosticMode).toBe("push");
  expect(second.diagnosticMode).toBe("push");
});

test("sessions share one server when the user has no account entry", async () => {
  const { cwd, sockets } = await workspace();
  vi.spyOn(os, "userInfo").mockImplementation(() => {
    throw new Error("A system error occurred: uv_os_get_passwd returned ENOENT");
  });
  // The default socket directory lives in the temporary directory and is named by the numeric uid.
  vi.stubEnv("TMPDIR", sockets);
  const first = await session(cwd, new LspSharedServers());
  const second = await session(cwd, new LspSharedServers());

  expect(first.shared).toBe(true);
  expect(second.pid).toBe(first.pid);
  expect(await readdir(sockets)).toContain(`pi-agent-ide-lsp-${process.getuid?.()}`);
});

test("each session gets diagnostics under its own document versions", async () => {
  const { cwd, sharing } = await workspace();
  const first = await session(cwd, sharing);
  const second = await session(cwd, sharing);
  const uri = URI.file(path.join(cwd, "first.fx")).toString();

  first.openDocument(uri, "first\n", "fixture", 5);
  await until(() => first.diagnosticPublication(uri)?.version === 5);
  second.openDocument(uri, "first\n", "fixture", 7);
  await until(() => second.diagnosticPublication(uri)?.version === 7);
  expect(second.diagnosticPublication(uri)?.diagnostics).toEqual([
    expect.objectContaining({ message: "fixture error" }),
  ]);
  expect((await status(first)).events).toEqual([["open", uri]]);

  first.closeDocument(uri);
  expect((await status(second)).open).toEqual([uri]);
  second.closeDocument(uri);
  // The server copy stays open briefly for a quick reopen, then closes.
  expect((await status(second)).open).toEqual([uri]);
  await until(async () => (await status(second)).open.length === 0);
});

test("sessions with different text each get diagnostics for their own version", async () => {
  const { cwd, sharing } = await workspace();
  const env = { LIFECYCLE_PUBLISH_DELAY_MS: "150" };
  const first = await session(cwd, sharing, undefined, LINGER_MS, env);
  const second = await session(cwd, sharing, undefined, LINGER_MS, env);
  const uri = URI.file(path.join(cwd, "first.fx")).toString();

  // The second text replaces the first before the server publishes for it.
  first.syncDocument(uri, "alpha\n", "fixture");
  second.syncDocument(uri, "beta\n", "fixture");

  await until(
    () =>
      first.diagnosticPublication(uri)?.version === first.documentVersion(uri) &&
      second.diagnosticPublication(uri)?.version === second.documentVersion(uri),
  );
});

test("a document reopened at once stays open on the server", async () => {
  const { cwd, sharing } = await workspace();
  const client = await session(cwd, sharing);
  const uri = URI.file(path.join(cwd, "first.fx")).toString();
  client.openDocument(uri, "first\n", "fixture", 1);
  await until(() => client.diagnosticPublication(uri)?.version === 1);

  client.closeDocument(uri);
  client.openDocument(uri, "first\n", "fixture", 1);

  // The report the server published for the same text answers the reopened document.
  await until(() => client.diagnosticPublication(uri)?.version === 1);
  expect((await status(client)).events).toEqual([["open", uri]]);
});

test("a late clear for a closed document does not reach the session that reopened it", async () => {
  const { cwd, sharing } = await workspace();
  // The clear arrives before the reopened document's report, so only the host can tell them apart.
  const env = { LIFECYCLE_CLEAR_DELAY_MS: "600", LIFECYCLE_PUBLISH_DELAY_MS: "900" };
  const first = await session(cwd, sharing, undefined, LINGER_MS, env);
  const second = await session(cwd, sharing, undefined, LINGER_MS, env);
  const uri = URI.file(path.join(cwd, "first.fx")).toString();
  // The host learns that the server versions its reports.
  first.openDocument(uri, "first\n", "fixture", 1);
  await until(() => first.diagnosticPublication(uri)?.version === 1);
  first.closeDocument(uri);
  await until(async () => (await status(first)).open.length === 0);
  const pushes: unknown[] = [];
  second.onNotification("textDocument/publishDiagnostics", (parameters) => {
    if ((parameters as { uri: string }).uri === uri) pushes.push(parameters);
  });

  // The server's clear for the close arrives after another session opened the document again.
  second.openDocument(uri, "first\n", "fixture", 1);
  await until(() => second.diagnosticPublication(uri)?.version === 1);
  expect(pushes).toEqual([
    { uri, version: 1, diagnostics: [expect.objectContaining({ message: "fixture error" })] },
  ]);
});

test("requests see the requesting session's text and versions", async () => {
  const { cwd, sharing } = await workspace();
  const first = await session(cwd, sharing);
  const second = await session(cwd, sharing);
  const uri = URI.file(path.join(cwd, "first.fx")).toString();
  const text = (client: LspClient) =>
    client.sendRequest<string>("lifecycle/text", { textDocument: { uri } });
  const rename = (client: LspClient) =>
    client.sendRequest<{ documentChanges: { textDocument: { version: number } }[] }>(
      "textDocument/rename",
      { textDocument: { uri }, position: { line: 0, character: 0 }, newName: "renamed" },
    );

  first.syncDocument(uri, "alpha\n", "fixture");
  second.syncDocument(uri, "beta\n", "fixture");
  second.syncDocument(uri, "gamma\n", "fixture");

  expect(await text(first)).toBe("alpha\n");
  expect(await text(second)).toBe("gamma\n");
  expect((await rename(second)).documentChanges[0]?.textDocument.version).toBe(
    second.documentVersion(uri),
  );
  expect((await rename(first)).documentChanges[0]?.textDocument.version).toBe(
    first.documentVersion(uri),
  );
  expect(await text(first)).toBe("alpha\n");
});

test("an answer keeps the requesting session's version when another session's text replaces it meanwhile", async () => {
  const { cwd, sharing } = await workspace();
  // The server publishes for the second session's text while its rename is still running, and the
  // host then gives the server the first session's text, which still waits for diagnostics.
  const env = { LIFECYCLE_PUBLISH_DELAY_MS: "100", LIFECYCLE_RENAME_DELAY_MS: "400" };
  const first = await session(cwd, sharing, undefined, LINGER_MS, env);
  const second = await session(cwd, sharing, undefined, LINGER_MS, env);
  const uri = URI.file(path.join(cwd, "first.fx")).toString();
  first.syncDocument(uri, "alpha\n", "fixture");
  second.syncDocument(uri, "gamma\n", "fixture");

  const renamed = await second.sendRequest<{
    documentChanges: { textDocument: { version: number } }[];
  }>("textDocument/rename", {
    textDocument: { uri },
    position: { line: 0, character: 0 },
    newName: "renamed",
  });

  expect(await second.sendRequest<string>("lifecycle/text", { textDocument: { uri } })).toBe(
    "gamma\n",
  );
  expect(renamed.documentChanges[0]?.textDocument.version).toBe(second.documentVersion(uri));
});

test("a session with an older copy of a file does not take the file's text from the server", async () => {
  const { cwd, sharing } = await workspace();
  const first = await session(cwd, sharing);
  const second = await session(cwd, sharing);
  const file = path.join(cwd, "first.fx");
  const uri = URI.file(file).toString();
  const text = (client: LspClient) =>
    client.sendRequest<string>("lifecycle/text", { textDocument: { uri } });
  first.syncDocument(uri, "first\n", "fixture");
  expect(await text(first)).toBe("first\n");

  // Another process edits the file; its session syncs the new text. File times come from a
  // coarse clock, so the write happens visibly later, as an agent's next edit does.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(file, "edited\n");
  second.syncDocument(uri, "edited\n", "fixture");
  expect(await text(second)).toBe("edited\n");

  // The first session still holds the old copy; its request leaves the file's text in place.
  expect(await text(first)).toBe("edited\n");
  expect((await status(first)).events.filter(([event]) => event === "open")).toHaveLength(1);
  // Once it syncs the file, it sees its own text again.
  first.syncDocument(uri, "edited\n", "fixture");
  expect(await text(first)).toBe("edited\n");
});

test("requests the server cancels as stale are retried through the shared host", async () => {
  const { cwd, sharing } = await workspace();
  const client = await session(cwd, sharing);
  const flaky = (key: string, code: number, failures: number, data?: unknown) =>
    client.sendRequest<number>("lifecycle/flaky", { key, code, failures, data });

  await expect(flaky("modified", -32_801, 2)).resolves.toBe(3);
  await expect(flaky("cancelled", -32_802, 1, { retriggerRequest: true })).resolves.toBe(2);
  await expect(flaky("final", -32_802, 1, { retriggerRequest: false })).rejects.toMatchObject({
    code: -32_802,
  });
  await expect(flaky("persistent", -32_801, 100)).rejects.toMatchObject({ code: -32_801 });
  await expect(flaky("persistent", -32_801, 0)).resolves.toBe(7);
  await expect(flaky("other", -32_603, 1)).rejects.toMatchObject({ code: -32_603 });

  const controller = new AbortController();
  const aborted = client.sendRequest(
    "lifecycle/flaky",
    { key: "aborted", code: -32_801, failures: 100 },
    controller.signal,
  );
  setTimeout(() => controller.abort(new Error("caller stopped")), 120);
  await expect(aborted).rejects.toThrow("caller stopped");
});

test("a session that attaches while the server loads the project waits for it too", async () => {
  const { cwd, sharing } = await workspace();
  const env = { LIFECYCLE_LOADING_MS: "1500" };
  const first = await session(cwd, sharing, undefined, LINGER_MS, env);
  await until(() => first.loading);
  // The server reported loading before this session attached; the host repeats the status.
  const second = await session(cwd, sharing, undefined, LINGER_MS, env);
  expect(second.pid).toBe(first.pid);
  await until(() => second.loading);
  await second.waitUntilLoaded();
  expect(await second.sendRequest("lifecycle/loaded", {})).toBe(true);
});

test("a save made while the server loads the project reaches it after loading", async () => {
  const { cwd, sharing } = await workspace();
  const env = { LIFECYCLE_LOADING_MS: "800", LIFECYCLE_SAVE: "1" };
  const client = await session(cwd, sharing, undefined, LINGER_MS, env);
  await until(() => client.loading);
  const uri = URI.file(path.join(cwd, "first.fx")).toString();

  // Like rust-analyzer, the fixture exits when a save arrives during loading.
  client.syncDocument(uri, "edited\n", "fixture", true);
  await client.waitUntilLoaded();

  expect(await client.sendRequest("lifecycle/saves", {})).toEqual([uri]);
  expect(client.crashed).toBe(false);
});

test.each([false, true])(
  "diagnostics are pulled from a server that registers pull after it starts (shared=%s)",
  async (shared) => {
    const { cwd, sharing } = await workspace();
    // Like pyright: its pushes are interim reports, and only a pull returns the analysis result.
    const env = { LIFECYCLE_PULL_DIAGNOSTICS: "1" };
    const connect = async () => {
      if (shared) return session(cwd, sharing, undefined, LINGER_MS, env);
      const client = new LspClient({
        serverId: "fixture",
        rootUri: URI.file(cwd).toString(),
        command: [process.execPath, SERVER],
        env,
      });
      clients.push(client);
      await client.start();
      return client;
    };
    const first = await connect();
    const uri = URI.file(path.join(cwd, "first.fx")).toString();
    first.syncDocument(uri, "broken\n", "fixture");
    await until(() => first.diagnosticMode === "pull");
    expect((await requestDiagnostics(first, uri, "fixture")).diagnostics).toMatchObject([
      { message: "fixture error" },
    ]);
    if (!shared) return;

    // A session that attaches after the registration learns it from the host.
    const second = await connect();
    second.syncDocument(uri, "broken\n", "fixture");
    await until(() => second.diagnosticMode === "pull");
    expect((await requestDiagnostics(second, uri, "fixture")).diagnostics).toMatchObject([
      { message: "fixture error" },
    ]);
  },
);

test("a server that crashes leaves its exit code and error output in the host log", async () => {
  const { cwd, sharing, sockets } = await workspace();
  const client = await session(cwd, sharing);

  // The server exits without answering.
  await expect(client.sendRequest("lifecycle/crash", {})).rejects.toThrow(/./u);
  const log = async () => {
    for (const name of await readdir(sockets))
      if (name.endsWith(".log")) return readFile(path.join(sockets, name), "utf8");
    return "";
  };
  await until(async () => (await log()).includes("exited with code 3"));
  expect(await log()).toContain("fixture panic: index out of bounds");
});

test("a host started after a crash keeps the crashed host's log", async () => {
  const { cwd, sharing, sockets } = await workspace();
  const client = await session(cwd, sharing);
  await expect(client.sendRequest("lifecycle/crash", {})).rejects.toThrow(/./u);
  const logs = async () =>
    Promise.all(
      (await readdir(sockets))
        .filter((name) => name.endsWith(".log"))
        .map((name) => readFile(path.join(sockets, name), "utf8")),
    );
  await until(async () => (await logs()).some((log) => log.includes("exited with code 3")));

  // The restart starts a new host for the same server.
  await client.restart();
  expect(await client.sendRequest("lifecycle/configuration", { section: "fixture.mode" })).toBe(
    "strict",
  );
  expect((await logs()).filter((log) => log.includes("fixture panic"))).toHaveLength(1);
});

test("the shared host answers server requests for settings and file watching", async () => {
  const { cwd, sharing } = await workspace();
  const client = await session(cwd, sharing);

  expect(await client.sendRequest("lifecycle/configuration", { section: "fixture.mode" })).toBe(
    "strict",
  );
  await client.sendRequest("lifecycle/watch", { pattern: "**/*.fx" });
  await writeFile(path.join(cwd, "second.fx"), "second\n");
  await until(async () =>
    (await status(client)).watched.some((change) => change.uri.endsWith("/second.fx")),
  );
});

test("a session leaving does not affect the others", async () => {
  const { cwd, sharing } = await workspace();
  const first = await session(cwd, sharing);
  const second = await session(cwd, sharing);
  const uri = URI.file(path.join(cwd, "first.fx")).toString();
  first.syncDocument(uri, "first\n", "fixture");
  second.syncDocument(uri, "first\n", "fixture");
  const pid = first.pid;

  await first.shutdown();

  expect(second.ready).toBe(true);
  expect(await status(second)).toMatchObject({ pid, open: [uri] });
  second.syncDocument(uri, "changed\n", "fixture");
  await until(() => second.diagnosticPublication(uri) !== undefined);
});

test(
  "the server stops after its last session has been gone for the linger time",
  { timeout: 15_000 },
  async () => {
    const { cwd, sharing, sockets } = await workspace();
    const first = await session(cwd, sharing, undefined, 1000);
    const pid = first.pid ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(alive(pid)).toBe(true);

    await first.shutdown();
    const returning = await session(cwd, sharing, undefined, 1000);
    expect(returning.pid).toBe(pid);
    await returning.shutdown();
    await until(() => !alive(pid));
    await until(async () => (await readdir(sockets)).length === 0);

    const next = await session(cwd, sharing);
    expect(next.shared).toBe(true);
    expect(next.pid).not.toBe(pid);
    expect((await status(next)).pid).toBe(next.pid);
  },
);

test("sessions see a crashed shared server and restart on a new one", async () => {
  const { cwd, sharing } = await workspace();
  const first = await session(cwd, sharing);
  const second = await session(cwd, sharing);
  const pid = first.pid ?? 0;

  process.kill(pid, "SIGKILL");
  await until(() => first.crashed && second.crashed);

  await first.restart();
  await second.restart();
  expect(first.shared).toBe(true);
  expect(first.pid).not.toBe(pid);
  expect(second.pid).toBe(first.pid);
  if (first.pid !== null) servers.add(first.pid);
  expect((await status(second)).pid).toBe(first.pid);
});

test("the host takes no session variables and removes files of dead hosts", async () => {
  const { cwd, sharing, sockets } = await workspace();
  const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  for (const name of ["dead.sock", "dead.log", "fresh.sock"])
    await writeFile(path.join(sockets, name), "");
  await utimes(path.join(sockets, "dead.sock"), old, old);
  await utimes(path.join(sockets, "dead.log"), old, old);
  const options = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--max-old-space-size=4321";
  let client: LspClient;
  try {
    client = await session(cwd, sharing);
  } finally {
    if (options === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = options;
  }

  const stat = await readFile(`/proc/${client.pid}/stat`, "utf8");
  const host = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
  expect(await readFile(`/proc/${host}/environ`, "utf8")).not.toContain("NODE_OPTIONS");
  await until(async () => !(await readdir(sockets)).includes("dead.sock"));
  expect(await readdir(sockets)).not.toContain("dead.log");
  expect(await readdir(sockets)).toContain("fresh.sock");
});

test("a session uses its own server when the shared host cannot be reached", async () => {
  const { cwd, sockets } = await workspace();
  await chmod(sockets, 0o755);
  const client = await session(cwd, new LspSharedServers({ directory: sockets }));

  expect(client.shared).toBe(false);
  expect((await status(client)).pid).toBe(client.pid);
  expect(await readdir(sockets)).toEqual([]);
});
