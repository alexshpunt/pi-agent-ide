import { readFile } from "node:fs/promises";
import path from "node:path";
import { startSshFixture } from "./ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshLspWorkspaceOwner } from "#src/backend/lsp-workspace-owner.js";
import { createSshLspTransport } from "#src/backend/lsp-transport.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { LspManager } from "#src/plugins/pi-agent-ide-lsp/src/lsp/manager.js";
import { LspServerRegistry } from "#src/plugins/pi-agent-ide-lsp/src/lsp/registry.js";
import type { LspOwnedProcess } from "#src/plugins/pi-agent-ide-lsp/src/lsp/owner-transport.js";

/** Observe a real owned server exit during a request, then restart and clean up before fixture teardown. */
export async function probeSshLspServerLoss(): Promise<{
  root: string;
  pid: number;
  restartedPid: number;
  exitCode: number | null;
  rejectedRequest: boolean;
  oldGoneBeforeTeardown: boolean;
  newGoneBeforeTeardown: boolean;
  canonicalSymbol: boolean;
}> {
  const fixture = await startSshFixture();
  const root = `ssh://fixture${fixture.workspace}`;
  const backends = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const owner = backends.resolve(root);
  if (!owner) throw new Error("Missing fixture owner");
  const access = createSshLspWorkspaceOwner(backends);
  const transport = createSshLspTransport(backends, root);
  const processes: LspOwnedProcess[] = [];
  access.transport = () => ({
    ...transport,
    async start(input) {
      const process = await transport.start(input);
      processes.push(process);
      return process;
    },
  });
  let manager: LspManager | undefined;
  const gone = async (pid: number): Promise<boolean> => {
    try {
      await readSshProcessMetadata(backends, root, pid);
      return false;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      return true;
    }
  };
  try {
    await owner.backend.write(
      `${fixture.workspace}/server.py`,
      await readFile(path.resolve("tests/integration/fixtures/lsp-owner-server.py")),
      null,
    );
    await owner.backend.write(
      `${fixture.workspace}/note.ts`,
      Buffer.from('const label = "café";\n'),
      null,
    );
    manager = LspManager.init(
      LspServerRegistry.fromConfig(
        {
          version: 1,
          servers: {
            owned: {
              command: ["python3", "{project}/server.py"],
              rootMarkers: [],
              languages: { typescript: { extensions: [".ts"] } },
              capabilities: [],
              initializationOptions: { ownerExitOnSymbolQuery: "exit" },
            },
          },
        },
        root,
      ),
      access,
    );
    const first = await manager.getOrStart(".ts", root, "symbols");
    if (!first?.remote || !processes[0]) throw new Error("Missing owned server");
    const pid = first.remote.pid;
    const report = await first
      .sendRequest("workspace/symbol", { query: "exit" })
      .catch((error: unknown) => error);
    if (!(report instanceof Error))
      throw new Error("Server exit was reported as a successful request");
    const next = await manager.getOrStart(".ts", root, "symbols");
    const { exitCode } = await processes[0].completion;
    const oldGoneBeforeTeardown = await gone(pid);
    if (!next?.remote) throw new Error("Missing restarted owned server");
    const restartedPid = next.remote.pid;
    if (restartedPid === pid) throw new Error("Server was not restarted");
    const symbols = await next.sendRequest<{ location: { uri: string } }[]>("workspace/symbol", {
      query: "label",
    });
    const canonicalSymbol = symbols[0]?.location.uri === `${root}/note.ts`;
    await manager.dispose();
    const newGoneBeforeTeardown = await gone(restartedPid);
    return {
      root,
      pid,
      restartedPid,
      exitCode,
      rejectedRequest: true,
      oldGoneBeforeTeardown,
      newGoneBeforeTeardown,
      canonicalSymbol,
    };
  } finally {
    try {
      await manager?.dispose();
    } finally {
      await fixture.stop();
    }
  }
}
