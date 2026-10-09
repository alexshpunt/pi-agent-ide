import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createOwnedFormatterRuntime } from "#src/backend/formatter-registration.js";
import { createFormatter } from "#src/plugins/pi-agent-ide-formatter/src/formatter.js";

test("owner formatter selection publishes stdout with a revision guard and preserves conflicting writes", async () => {
  const fixture = await startSshFixture();
  const root = `ssh://fixture${fixture.workspace}`;
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const owner = registry.resolve(root);
  if (!owner) throw new Error("Missing fixture owner");
  const runtime = createOwnedFormatterRuntime(registry);
  const source = `${root}/note.fixture`;
  const formatter = createFormatter(runtime);
  const command = [
    "python3",
    "-c",
    "import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text().upper(),end='')",
    "{file}",
  ];
  try {
    await owner.backend.write(
      `${fixture.workspace}/.pi/pi-agent-ide/formatters.json`,
      Buffer.from(
        JSON.stringify({
          version: 1,
          formatters: { owned: { extensions: [".fixture"], run: { command }, output: "stdout" } },
        }),
      ),
      null,
    );
    await owner.backend.write(`${fixture.workspace}/note.fixture`, Buffer.from("before\n"), null);
    expect(
      await formatter.format({ filePath: source }, { cwd: "/controller/project" }),
    ).toMatchObject({ ok: true, edits: 1, formatter: "python3" });
    expect(
      (await owner.backend.read(`${fixture.workspace}/note.fixture`)).bytes.toString("utf8"),
    ).toBe("BEFORE\n");
    await expect(
      runtime.run(
        {
          extensions: [".fixture"],
          run: {
            command: [
              "python3",
              "-c",
              "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('external\\n'); print('formatted')",
              "{file}",
            ],
          },
          output: "stdout",
        },
        root,
        source,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", effect: "not-applied" });
    expect(
      (await owner.backend.read(`${fixture.workspace}/note.fixture`)).bytes.toString("utf8"),
    ).toBe("external\n");
    await expect(
      runtime.run(
        {
          extensions: [".fixture"],
          run: {
            command: [
              "python3",
              "-c",
              "import pathlib,sys; p=pathlib.Path(sys.argv[1]); before=p.read_text(); p.write_text('external unchanged-output\\n'); print(before,end='')",
              "{file}",
            ],
          },
          output: "stdout",
        },
        root,
        source,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", effect: "not-applied" });
    expect(
      (await owner.backend.read(`${fixture.workspace}/note.fixture`)).bytes.toString("utf8"),
    ).toBe("external unchanged-output\n");
    expect(
      await runtime.run(
        {
          extensions: [".fixture"],
          run: {
            command: [
              "python3",
              "-c",
              "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('partial\\n'); sys.exit(1)",
              "{file}",
            ],
          },
          output: "in-place",
        },
        root,
        source,
      ),
    ).toEqual({ ok: false, changed: true });
    expect(
      (await owner.backend.read(`${fixture.workspace}/note.fixture`)).bytes.toString("utf8"),
    ).toBe("partial\n");
  } finally {
    await fixture.stop();
  }
}, 20000);
