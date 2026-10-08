import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackend } from "#src/backend/ssh.js";
import { resolveSshToolProject } from "#src/backend/tool-project.js";
import { LSP_RECIPES } from "#src/plugins/pi-agent-ide-lsp/index.js";

test("an explicit SSH file discovers its nearest native project rather than the default workspace", async () => {
  const fixture = await startSshFixture();
  try {
    const backend = new SshBackend({
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    });
    const project = `${fixture.workspace}/nested`;
    const file = `${project}/src/note.ts`;
    await backend.write(file, Buffer.from('export const label = "café";\n'), null);
    await backend.write(`${project}/tsconfig.json`, Buffer.from("{}"), null);
    expect(
      await resolveSshToolProject(backend, file, undefined, "lsp-servers", LSP_RECIPES),
    ).toEqual({ cwd: `ssh://fixture${project}`, external: false });
    expect(
      await resolveSshToolProject(backend, file, fixture.workspace, "lsp-servers", LSP_RECIPES),
    ).toEqual({ cwd: `ssh://fixture${fixture.workspace}`, external: false });
    await backend.remove(
      `${project}/tsconfig.json`,
      (await backend.read(`${project}/tsconfig.json`)).version,
    );
    await backend.write(
      `${project}/.pi/pi-agent-ide/lsp-servers.json`,
      Buffer.from('{"version":1,"servers":{}}'),
      null,
    );
    expect(
      await resolveSshToolProject(backend, file, undefined, "lsp-servers", LSP_RECIPES),
    ).toEqual({ cwd: `ssh://fixture${project}`, external: false });
    expect(
      await resolveSshToolProject(backend, project, undefined, "lsp-servers", LSP_RECIPES),
    ).toEqual({ cwd: `ssh://fixture${project}`, external: false });
  } finally {
    await fixture.stop();
  }
});
