import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createOwnedLintRuntime } from "#src/backend/lint-registration.js";

test("owner lint commands keep native cwd and filter foreign diagnostic paths without rewriting messages", async () => {
  const fixture = await startSshFixture();
  const root = `ssh://fixture${fixture.workspace}`;
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const owner = registry.resolve(root);
  if (!owner) throw new Error("Missing fixture owner");
  const runtime = createOwnedLintRuntime(registry);
  const source = `${root}/note.fixture`;
  try {
    await owner.backend.write(`${fixture.workspace}/note.fixture`, Buffer.from("before\n"), null);
    const result = await runtime.run(
      {
        extensions: [".fixture"],
        check: {
          command: [
            "python3",
            "-c",
            "import json,pathlib,sys; print(json.dumps({'diagnostics':[{'file':pathlib.Path(sys.argv[1]).as_uri(),'line':1,'column':1,'severity':'warning','message':'literal file:///message/text'},{'file':'other.fixture','line':1,'severity':'error','message':'other file'}]}))",
            "{file}",
          ],
        },
        diagnostics: { format: "pi-json" },
      },
      { projectRoot: root, filePath: source },
    );
    expect(result).toMatchObject({
      ok: true,
      diagnostics: [
        { line: 1, column: 1, severity: "warning", message: "literal file:///message/text" },
      ],
    });
    expect(result.diagnostics).toHaveLength(1);
    await expect(
      runtime.resolveProject("ssh://unknown/tmp/note.fixture", "/controller/project"),
    ).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
  } finally {
    await fixture.stop();
  }
}, 10000);
