import { expect, test, vi } from "vitest";
import { probeOwnedCommandCancellation } from "#integration/support/ssh-command-probe.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshConfiguredProcessAccess } from "#src/backend/configured-process.js";
import { runConfiguredProcess } from "#src/api/tool-config.js";

test("configured owner commands expand native argv and inherit only the owner environment", async () => {
  const fixture = await startSshFixture({}, { OWNER_ONLY: "remote-value" });
  const root = `ssh://fixture${fixture.workspace}`;
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const access = createSshConfiguredProcessAccess(registry);
  const owner = registry.resolve(root);
  if (!owner) throw new Error("Missing fixture owner");
  const commands = vi.spyOn(owner.backend, "execute");
  try {
    const active = new AbortController();
    const result = await runConfiguredProcess(
      {
        command: [
          "python3",
          "-c",
          "import json,os,sys; print(json.dumps([os.getcwd(),sys.argv[1:],os.getenv('OWNER_ONLY'),os.getenv('CONFIGURED_ONLY')]))",
          "{project}",
          "{file}",
          "{fileDir}",
          "{relativeFile}",
          "literal ; $(false)",
        ],
        env: { CONFIGURED_ONLY: "configured-value" },
      },
      {
        projectRoot: root,
        filePath: `${root}/note.ts`,
        processAccess: access,
        env: { OWNER_ONLY: "controller-value" },
        signal: active.signal,
      },
    );
    expect(result.ok).toBe(true);
    expect(commands.mock.calls[0]?.[3]?.signal).toBe(active.signal);
    expect(JSON.parse(result.stdout)).toEqual([
      fixture.workspace,
      [
        fixture.workspace,
        `${fixture.workspace}/note.ts`,
        fixture.workspace,
        "note.ts",
        "literal ; $(false)",
      ],
      "remote-value",
      "configured-value",
    ]);
    await expect(
      runConfiguredProcess(
        {
          command: [
            "python3",
            "-c",
            "import sys; assert sys.stdin.read() == ''; print('Owned stdout café'); print('Owned stderr café', file=sys.stderr); sys.exit(7)",
          ],
          successExitCodes: [7],
        },
        { projectRoot: root, filePath: `${root}/note.ts`, processAccess: access },
      ),
    ).resolves.toEqual({
      ok: true,
      exitCode: 7,
      stdout: "Owned stdout café\n",
      stderr: "Owned stderr café\n",
    });
    const stopped = new AbortController();
    const beforeCancel = commands.mock.calls.length;
    stopped.abort(new Error("Owned command cancelled"));
    await expect(
      runConfiguredProcess(
        { command: ["python3", "-c", "print('unexpected')"] },
        {
          projectRoot: root,
          filePath: `${root}/note.ts`,
          processAccess: access,
          signal: stopped.signal,
        },
      ),
    ).rejects.toThrow("Owned command cancelled");
    expect(commands.mock.calls).toHaveLength(beforeCancel);
    await expect(
      runConfiguredProcess(
        { command: ["python3"] },
        { projectRoot: root, filePath: "ssh://unknown/tmp/note.ts", processAccess: access },
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
  } finally {
    commands.mockRestore();
    await fixture.stop();
  }
}, 15000);

test.each(["cancel", "deadline"] as const)(
  "configured owner %s awaits native cleanup without rolling back a changed file",
  async (mode) => {
    const proof = await probeOwnedCommandCancellation(mode, "configured");
    expect(proof.nativeGoneBeforeTeardown).toBe(true);
    expect(proof.siblingAliveBeforeTeardown).toBe(true);
    expect(proof.sourcePreserved).toBe(true);
    expect(proof.changedSource).toBe('label = "café after command"\n');
    expect(proof.code).toBe(mode === "cancel" ? "CANCELLED" : "TIMEOUT");
    expect(proof.effect).toBe("unknown");
  },
  20000,
);
