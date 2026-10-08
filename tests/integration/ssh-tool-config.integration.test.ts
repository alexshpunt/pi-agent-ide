import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshToolConfigAccess } from "#src/backend/tool-config-access.js";
import { loadLayeredToolConfig, parseFormattersConfig } from "#src/api/tool-config.js";

const entry = (command: string) => ({
  extensions: [".ts"],
  run: { command: [command] },
  output: "stdout",
});

test("tool layers read the remote project and remote agent directory with normal precedence", async () => {
  const fixture = await startSshFixture({}, { PI_CODING_AGENT_DIR: "{workspace}/agent-home" });
  try {
    const root = `ssh://fixture${fixture.workspace}`;
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const access = createSshToolConfigAccess(registry);
    const paths = await access.paths(root, "formatters");
    expect(paths.global).toBe(`${root}/agent-home/extensions/pi-agent-ide/formatters.json`);
    const publish = async (
      source: string,
      formatters: Record<string, ReturnType<typeof entry>>,
    ) => {
      const owner = registry.resolve(source);
      if (!owner) throw new Error("Missing fixture owner");
      await owner.backend.write(
        owner.location.path,
        Buffer.from(JSON.stringify({ version: 1, formatters })),
        null,
      );
    };
    await publish(paths.project, { owned: entry("project-tool") });
    await publish(paths.global, {
      owned: entry("global-tool"),
      globalOnly: entry("remote-global-tool"),
    });
    const result = await loadLayeredToolConfig(
      root,
      "formatters",
      (value) => parseFormattersConfig(value).formatters,
      { layerAccess: access, homeDirectory: "/must-not-be-used" },
    );
    expect(result.entries.find((item) => item.id === "owned")).toMatchObject({
      layer: "project",
      sourcePath: paths.project,
      config: { run: { command: ["project-tool"] } },
    });
    expect(result.entries.find((item) => item.id === "globalOnly")).toMatchObject({
      layer: "global",
      sourcePath: paths.global,
    });
    expect(result.entries.some((item) => item.layer === "built-in")).toBe(true);
    const withoutGlobal = await loadLayeredToolConfig(
      root,
      "formatters",
      (value) => parseFormattersConfig(value).formatters,
      { layerAccess: access, includeGlobal: false },
    );
    expect(withoutGlobal.entries.some((item) => item.id === "globalOnly")).toBe(false);
    const owner = registry.resolve(paths.global);
    if (!owner) throw new Error("Missing fixture owner");
    await owner.backend.write(
      owner.location.path,
      Buffer.from("invalid JSON"),
      (await owner.backend.read(owner.location.path)).version,
    );
    await expect(
      loadLayeredToolConfig(
        root,
        "formatters",
        (value) => parseFormattersConfig(value).formatters,
        { layerAccess: access },
      ),
    ).rejects.toThrow("Invalid global formatters config");
    await expect(access.paths("ssh://unknown/tmp", "formatters")).rejects.toMatchObject({
      code: "UNKNOWN_TARGET",
    });
  } finally {
    await fixture.stop();
  }
}, 60_000);
