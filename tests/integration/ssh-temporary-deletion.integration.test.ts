import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { FileOperationPolicy } from "pi-agent-text-editor/api/plugin-protocol";
import type { BeforeDeleteEvent } from "#src/extensions/pi-agent-text-editor/src/api/delete-guard.js";
import { prepareDeletion } from "#src/extensions/pi-agent-text-editor/src/core/delete-policy.js";
import { createSshFileOperationResolver } from "#src/backend/file-operation-resolver.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { sshTransferPolicy } from "#integration/support/ssh-transfer-policy.js";

test.each(["defaults", "settings", "recheck"] as const)(
  "SSH temporary Delete uses target-owned %s",
  async (scenario) => {
    const fixture = await startSshFixture(
      {},
      {
        HOME: "{workspace}/home",
        TMPDIR: "{workspace}/system",
        PI_CODING_AGENT_DIR: "{workspace}/agent",
      },
    );
    const project = path.join(fixture.workspace, "project");
    const home = path.join(fixture.workspace, "home");
    const system = path.join(fixture.workspace, "system");
    const agent = path.join(fixture.workspace, "agent");
    const globalConfig = path.join(agent, "pi-agent-ide/deletion.json");
    const projectConfig = path.join(project, ".pi/pi-agent-ide/deletion.json");
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: project, configFile: fixture.config },
    ]);
    const owner = registry.resolve(`ssh://fixture${project}`);
    if (!owner) throw Error("Missing target owner");
    const confirm = vi.fn(async () => false);
    const beforeDelete = vi.fn(async (_event: BeforeDeleteEvent) => {
      if (scenario === "recheck") await config(globalConfig, "replace", []);
    });
    const policy: FileOperationPolicy = {
      ...sshTransferPolicy,
      prepare: (source, cwd, files) =>
        prepareDeletion(source, cwd, { files, confirm, beforeDelete }),
    };
    const operate = createSshFileOperationResolver(registry);
    const remove = (file: string) =>
      operate("delete", { path: `ssh://fixture${file}` }, { cwd: fixture.root }, policy);
    async function config(file: string, mode: string, paths: string[]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ temporaryDirectories: { mode, paths } }));
    }
    try {
      const setup = await owner.backend.execute(
        "python3",
        [
          "-c",
          String.raw`
import pathlib,subprocess,sys
w=pathlib.Path(sys.argv[1])
for name in ['project','home','system','agent','home/tmp/scratch','home/global-scratch/scratch','system/scratch','project/tmp/tracked','outside-temp']:
 (w/name).mkdir(parents=True,exist_ok=True)
for name in ['home/tmp/scratch','home/global-scratch/scratch','system/scratch','project/tmp/tracked']:
 (w/name/'data').write_text('keep')
subprocess.run(['git','init','-q',str(w/'project')],check=True)
subprocess.run(['git','-C',str(w/'project'),'add','tmp/tracked'],check=True)
`,
          fixture.workspace,
        ],
        fixture.workspace,
      );
      expect(setup.exitCode).toBe(0);
      expect(await owner.backend.temporaryEnvironment()).toEqual({
        home,
        temporary: system,
        agentDirectory: agent,
      });
      if (scenario === "defaults") {
        for (const target of [path.join(home, "tmp/scratch"), path.join(system, "scratch")]) {
          expect(await remove(target)).toMatchObject({ ok: true, effect: "applied" });
          await expect(owner.backend.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(confirm).not.toHaveBeenCalled();
        for (const target of [
          system,
          path.join(project, "tmp/tracked"),
          path.join(fixture.workspace, "outside-temp"),
        ]) {
          await expect(remove(target)).rejects.toMatchObject({
            code: "DELETE_NOT_APPROVED",
            effect: "not-applied",
          });
        }
        expect(confirm).toHaveBeenCalledTimes(3);
        await expect(remove(project)).rejects.toMatchObject({ code: "DELETE_PROTECTED_TARGET" });
        expect(await readFile(path.join(project, "tmp/tracked/data"), "utf8")).toBe("keep");
      } else if (scenario === "settings") {
        await config(globalConfig, "replace", ["global-scratch"]);
        await expect(remove(path.join(system, "scratch"))).rejects.toMatchObject({
          code: "DELETE_NOT_APPROVED",
        });
        expect(await remove(path.join(home, "global-scratch/scratch"))).toMatchObject({ ok: true });
        await config(projectConfig, "extend", ["~/tmp"]);
        expect(await remove(path.join(home, "tmp/scratch"))).toMatchObject({ ok: true });
        await config(projectConfig, "replace", []);
        await expect(remove(path.join(system, "scratch"))).rejects.toMatchObject({
          code: "DELETE_NOT_APPROVED",
        });
        await config(projectConfig, "invalid", []);
        await expect(remove(path.join(system, "scratch"))).rejects.toThrow(
          "Invalid temporaryDirectories",
        );
        expect(await readFile(path.join(system, "scratch/data"), "utf8")).toBe("keep");
      } else {
        await expect(remove(path.join(system, "scratch"))).rejects.toMatchObject({
          code: "DELETE_TARGET_CHANGED",
          effect: "not-applied",
        });
        expect(confirm).not.toHaveBeenCalled();
        expect(beforeDelete).toHaveBeenCalledOnce();
        expect(beforeDelete.mock.calls[0]?.[0]).toMatchObject({
          path: `ssh://fixture${path.join(system, "scratch")}`,
          cwd: `ssh://fixture${project}`,
        });
        expect(await readFile(path.join(system, "scratch/data"), "utf8")).toBe("keep");
      }
    } finally {
      await fixture.stop();
    }
  },
  90_000,
);
