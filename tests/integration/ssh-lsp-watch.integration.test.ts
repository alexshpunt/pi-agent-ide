import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshLspTransport } from "#src/backend/lsp-transport.js";
import { createSshLspFileWatchers } from "#src/backend/lsp-file-watchers.js";
import { LspClient } from "#src/plugins/pi-agent-ide-lsp/src/lsp/client.js";

interface WatchStatus {
  watching: { dynamicRegistration: boolean };
  watchRegistered: boolean;
  watchUnregistered?: boolean;
  watchChanges: { uri: string; type: number }[];
}

test("remote language-server subscriptions observe their owner and release the watcher process", async () => {
  const fixture = await startSshFixture();
  const root = `ssh://fixture${fixture.workspace}`;
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const owner = registry.resolve(root);
  if (!owner) throw new Error("Missing fixture owner");
  const channels: Awaited<ReturnType<typeof owner.backend.startProcess>>[] = [];
  const startProcess = owner.backend.startProcess.bind(owner.backend);
  const processes = vi.spyOn(owner.backend, "startProcess").mockImplementation(async (...args) => {
    const channel = await startProcess(...args);
    channels.push(channel);
    return channel;
  });
  const client = new LspClient({
    serverId: "owned-watch",
    rootUri: root,
    command: ["python3", "{project}/server.py"],
    initOptions: { ownerWatchTest: true },
    ownerTransport: createSshLspTransport(registry, root),
  });
  const status = () => client.sendRequest<WatchStatus>("matrix/status", {});
  try {
    await owner.backend.write(
      `${fixture.workspace}/server.py`,
      await readFile(path.resolve("tests/integration/fixtures/lsp-owner-server.py")),
      null,
    );
    await owner.backend.write(`${fixture.workspace}/existing.ts`, Buffer.from("before\n"), null);
    await client.start();
    await expect.poll(async () => (await status()).watchRegistered, { timeout: 5000 }).toBe(true);
    expect((await status()).watching.dynamicRegistration).toBe(true);
    client.openDocument(`${root}/existing.ts`, "before\n", "typescript");
    const changed = await owner.backend.execute(
      "python3",
      [
        "-c",
        "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('after\\n')",
        `${fixture.workspace}/existing.ts`,
      ],
      fixture.workspace,
    );
    expect(changed.exitCode).toBe(0);
    await expect
      .poll(async () => (await status()).watchChanges, { timeout: 5000 })
      .toContainEqual({ uri: `${root}/existing.ts`, type: 2 });
    await expect
      .poll(() => client.diagnosticPublication(`${root}/existing.ts`)?.diagnostics[0]?.message, {
        timeout: 5000,
      })
      .toContain("Owned watcher events: 2 file://");
    await owner.backend.write(`${fixture.workspace}/created.ts`, Buffer.from("created\n"), null);
    await expect
      .poll(async () => (await status()).watchChanges, { timeout: 5000 })
      .toContainEqual({ uri: `${root}/created.ts`, type: 1 });
    await owner.backend.remove(
      `${fixture.workspace}/created.ts`,
      (await owner.backend.read(`${fixture.workspace}/created.ts`)).version,
    );
    await expect
      .poll(async () => (await status()).watchChanges, { timeout: 5000 })
      .toContainEqual({ uri: `${root}/created.ts`, type: 3 });
    expect(
      (
        await owner.backend.execute(
          "python3",
          [
            "-c",
            "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.mkdir(); (p/'nested.ts').write_text('nested\\n')",
            `${fixture.workspace}/tree`,
          ],
          fixture.workspace,
        )
      ).exitCode,
    ).toBe(0);
    await expect
      .poll(async () => (await status()).watchChanges, { timeout: 5000 })
      .toContainEqual({ uri: `${root}/tree/nested.ts`, type: 1 });
    expect(
      (
        await owner.backend.execute(
          "mv",
          [`${fixture.workspace}/tree`, `${fixture.workspace}/moved`],
          fixture.workspace,
        )
      ).exitCode,
    ).toBe(0);
    await expect
      .poll(async () => (await status()).watchChanges, { timeout: 5000 })
      .toContainEqual({ uri: `${root}/tree/nested.ts`, type: 3 });
    await expect
      .poll(async () => (await status()).watchChanges, { timeout: 5000 })
      .toContainEqual({ uri: `${root}/moved/nested.ts`, type: 1 });
    expect(
      (
        await owner.backend.execute(
          "python3",
          [
            "-c",
            "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('updated\\n')",
            `${fixture.workspace}/moved/nested.ts`,
          ],
          fixture.workspace,
        )
      ).exitCode,
    ).toBe(0);
    await expect
      .poll(async () => (await status()).watchChanges, { timeout: 5000 })
      .toContainEqual({ uri: `${root}/moved/nested.ts`, type: 2 });
    const watchers = channels.filter((channel) => channel.pid !== client.remote?.pid);
    expect(watchers.length).toBeGreaterThan(0);
    await client.sendRequest("matrix/unregisterWatch", {});
    await expect.poll(async () => (await status()).watchUnregistered, { timeout: 5000 }).toBe(true);
    for (const watcher of watchers) {
      await watcher.completion;
      expect(
        (await owner.backend.execute("kill", ["-0", String(watcher.pid)], fixture.workspace))
          .exitCode,
      ).not.toBe(0);
    }
  } finally {
    await client.shutdown();
    processes.mockRestore();
    await fixture.stop();
  }
}, 30000);

test("disposing an SSH subscription during readiness releases its actual remote process", async () => {
  const fixture = await startSshFixture();
  const root = `ssh://fixture${fixture.workspace}`;
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const owner = registry.resolve(root);
  if (!owner) throw new Error("Missing fixture owner");
  const channels: Awaited<ReturnType<typeof owner.backend.startProcess>>[] = [];
  const startProcess = owner.backend.startProcess.bind(owner.backend);
  const processes = vi
    .spyOn(owner.backend, "startProcess")
    .mockImplementation(async (command, args, cwd, options) => {
      const delayed = [...args];
      const script = delayed.indexOf("-c") + 1;
      delayed[script] = `import time; time.sleep(2)\n${delayed[script]}`;
      const channel = await startProcess(command, delayed, cwd, options);
      channels.push(channel);
      return channel;
    });
  const failed = vi.fn<(error: Error) => void>();
  const subscriptions = createSshLspFileWatchers(registry, root, () => undefined, failed);
  try {
    const registration = subscriptions.register("pending", [{ globPattern: "**/*.ts" }]);
    const rejected = expect(registration).rejects.toThrow(/WATCH_(FAILED|DISPOSED)/);
    await expect.poll(() => channels.length, { timeout: 5000 }).toBe(1);
    await subscriptions.dispose();
    await rejected;
    expect(failed).not.toHaveBeenCalled();
    for (const channel of channels) {
      await channel.completion;
      expect(
        (await owner.backend.execute("kill", ["-0", String(channel.pid)], fixture.workspace))
          .exitCode,
      ).not.toBe(0);
    }
  } finally {
    await subscriptions.dispose();
    processes.mockRestore();
    await fixture.stop();
  }
}, 15000);
