import { expect, test, vi } from "vitest";
import type { ToolRecipe } from "pi-agent-doctor/api/catalog";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackend } from "#src/backend/ssh.js";
import { inspectSshRecipeEvidence } from "#src/backend/recipe-evidence.js";

const recipe: ToolRecipe = {
  id: "owned",
  name: "Owned server",
  kind: "lsp",
  languages: ["typescript"],
  executables: ["owned-server"],
  documentation: "https://example.com/owned",
  configFiles: ["*.owned.json"],
  configSections: { "package.json": ["owned.settings"] },
  dependencies: ["owned-server"],
};

test("SSH native evidence shares scoring and reads its selected files in one request", async () => {
  const fixture = await startSshFixture();
  try {
    const backend = new SshBackend({
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    });
    await backend.write(
      `${fixture.workspace}/package.json`,
      Buffer.from(
        JSON.stringify({ devDependencies: { "owned-server": "1" }, owned: { settings: {} } }),
      ),
      null,
    );
    const marker = `${fixture.workspace}/app.owned.json`;
    await backend.write(marker, Buffer.from("{}"), null);
    const execute = vi.spyOn(backend, "execute");
    expect(
      (await inspectSshRecipeEvidence(backend, fixture.workspace, [recipe])).get("owned"),
    ).toEqual({ score: 10, config: "*.owned.json", dependency: "owned-server" });
    expect(execute).toHaveBeenCalledTimes(1);
    await backend.remove(marker, (await backend.read(marker)).version);
    expect(
      (await inspectSshRecipeEvidence(backend, fixture.workspace, [recipe])).get("owned"),
    ).toEqual({ score: 10, config: "package.json", dependency: "owned-server" });
    await expect(
      inspectSshRecipeEvidence(backend, fixture.workspace, [
        { ...recipe, configFiles: ["/etc/passwd"] },
      ]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  } finally {
    await fixture.stop();
  }
});
