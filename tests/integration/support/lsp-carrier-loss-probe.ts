import { readFile } from "node:fs/promises";
import { startSshCarrierFixture } from "./ssh-carrier-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { findSshProcessMetadata } from "#src/backend/process-metadata.js";
import { createSshLspWorkspaceOwner } from "#src/backend/lsp-workspace-owner.js";
import { LspManager } from "#src/plugins/pi-agent-ide-lsp/src/lsp/manager.js";
import { LspServerRegistry } from "#src/plugins/pi-agent-ide-lsp/src/lsp/registry.js";

/** Cut one real SSH carrier, inspect native absence independently, then restart the language server. */
export async function probeSshLspCarrierLoss() {
  const fixture = await startSshCarrierFixture();
  const root = `ssh://fixture${fixture.workspace}`;
  const proxied = new SshBackendRegistry([fixture.target]);
  const direct = new SshBackendRegistry([fixture.direct.target]);
  const note = `${root}/note.ts`;
  let manager: LspManager | undefined;
  const failures: unknown[] = [];
  let proof:
    | {
        root: string;
        pid: number;
        restartedPid: number;
        requestRejected: boolean;
        oldGoneBeforeTeardown: boolean;
        newGoneBeforeTeardown: boolean;
        diagnosticsCleared: boolean;
        canonicalSymbol: boolean;
      }
    | undefined;
  try {
    await fixture.direct.write(
      `${fixture.workspace}/server.py`,
      await readFile("tests/integration/fixtures/lsp-owner-server.py"),
      null,
    );
    await fixture.direct.write(
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
            },
          },
        },
        root,
      ),
      createSshLspWorkspaceOwner(proxied),
    );
    const first = (await manager.openFile(note, root, "symbols"))?.client;
    if (!first?.remote) throw new Error("No exact owned language server");
    const pid = first.remote.pid;
    const readyDeadline = Date.now() + 3000;
    while (first.diagnosticPublication(note)?.version !== 1 && Date.now() < readyDeadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    if (first.diagnosticPublication(note)?.version !== 1)
      throw new Error("No native push diagnostic before loss");
    const marker = `${fixture.workspace}/request-ready`;
    const pending = first.sendRequest("matrix/hold", { marker }).catch((error: unknown) => error);
    const observed = await fixture.direct.execute(
      "python3",
      [
        "-c",
        "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); end=time.monotonic()+3\nwhile not p.exists() and time.monotonic()<end: time.sleep(.02)\nprint(p.read_text() if p.exists() else 'missing')",
        marker,
      ],
      fixture.workspace,
    );
    if (observed.stdout.toString("utf8") !== `${pid}\n`)
      throw new Error("Native request was not held by the exact server");
    if ((await fixture.dropConnections()) !== 1)
      throw new Error("Did not cut exactly the owned LSP carrier");
    const failure = await pending;
    if (!(failure instanceof Error) || !failure.message.includes("connection got disposed"))
      throw new Error("Lost request was not rejected by its protocol connection", {
        cause: failure,
      });
    const gone = await fixture.direct.execute(
      "python3",
      [
        "-c",
        "import pathlib,sys,time; p=pathlib.Path('/proc')/sys.argv[1]; end=time.monotonic()+3\nwhile p.exists() and time.monotonic()<end: time.sleep(.02)\nprint('alive' if p.exists() else 'gone')",
        String(pid),
      ],
      fixture.workspace,
    );
    if (
      gone.stdout.toString("utf8") !== "gone\n" ||
      (await findSshProcessMetadata(direct, root, pid)) !== undefined
    )
      throw new Error("Exact language server survived carrier loss");
    if (!first.crashed || first.diagnosticPublication(note) !== undefined)
      throw new Error("Lost server retained current diagnostics");
    const next = await manager.getOrStart(".ts", root, "symbols");
    if (!next?.remote || next.remote.pid === pid)
      throw new Error("No new exact native language server");
    const restartedPid = next.remote.pid;
    const symbols = await next.sendRequest<{ location: { uri: string } }[]>("workspace/symbol", {
      query: "label",
    });
    if (symbols[0]?.location.uri !== note)
      throw new Error("Restarted symbols lost their native owner");
    await manager.dispose();
    if ((await findSshProcessMetadata(direct, root, restartedPid)) !== undefined)
      throw new Error("Restarted server remained alive after stop");
    proof = {
      root: fixture.root,
      pid,
      restartedPid,
      requestRejected: true,
      oldGoneBeforeTeardown: true,
      newGoneBeforeTeardown: true,
      diagnosticsCleared: true,
      canonicalSymbol: true,
    };
  } catch (error) {
    failures.push(error);
  }
  try {
    await manager?.dispose();
  } catch (error) {
    failures.push(error);
  }
  try {
    await fixture.stop();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures, "Owned LSP carrier probe failed");
  if (!proof) throw new Error("No completed native carrier proof");
  return proof;
}
