import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { startSshCarrierFixture } from "#integration/support/ssh-carrier-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { startSshDapTransport } from "#src/backend/dap-transport.js";
import { DapClient } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";

test("a real DAP carrier cut rejects its pending request and confirms native cleanup without stopping a sibling", async () => {
  const fixture = await startSshCarrierFixture();
  const scope = `ssh://fixture${fixture.workspace}`;
  const direct = new SshBackendRegistry([fixture.direct.target]);
  const registry = new SshBackendRegistry([fixture.target]);
  let client: DapClient | undefined;
  const sibling = await fixture.direct.startProcess(
    "python3",
    ["-c", "import time;time.sleep(60)"],
    fixture.workspace,
  );
  sibling.stdout.resume();
  sibling.stderr.resume();
  try {
    await fixture.direct.write(
      `${fixture.workspace}/adapter.py`,
      await readFile("tests/integration/fixtures/dap-owner-server.py"),
      null,
    );
    const marker = `${fixture.workspace}/dap-request-ready`;
    const transport = await startSshDapTransport(registry, scope, {
      command: "python3",
      args: [`${fixture.workspace}/adapter.py`],
      env: { PI_IDE_DAP_PEER_RECEIVED: marker },
    });
    client = DapClient.fromTransport(transport);
    await client.request("initialize", {}, { timeoutMs: 5000 });
    const pending = client
      .request("pending", {}, { timeoutMs: 5000 })
      .catch((error: unknown) => error);
    const ready = await fixture.direct.execute(
      "python3",
      [
        "-c",
        "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); end=time.monotonic()+3\nwhile (not p.exists() or p.read_text()!='pending') and time.monotonic()<end: time.sleep(.02)\nprint(p.read_text() if p.exists() else 'missing')",
        marker,
      ],
      fixture.workspace,
    );
    expect(ready.stdout.toString("utf8")).toBe("pending\n");
    expect(await fixture.dropConnections()).toBe(1);
    const failure = await pending;
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toMatch(/timed out/iu);
    const gone = await fixture.direct.execute(
      "python3",
      [
        "-c",
        "import pathlib,sys,time; p=pathlib.Path('/proc')/sys.argv[1]; end=time.monotonic()+3\nwhile p.exists() and time.monotonic()<end: time.sleep(.02)\nprint('alive' if p.exists() else 'gone')",
        String(transport.remote.pid),
      ],
      fixture.workspace,
    );
    expect(gone.stdout.toString("utf8")).toBe("gone\n");
    await expect(readSshProcessMetadata(direct, scope, transport.remote.pid)).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(client.dispose()).resolves.toBeUndefined();
    expect((await readSshProcessMetadata(direct, scope, sibling.pid))[0]?.identity).toBe(
      sibling.identity,
    );
  } finally {
    try {
      await client?.dispose();
    } finally {
      try {
        await sibling.stop();
      } finally {
        await fixture.stop();
      }
    }
  }
}, 30000);
