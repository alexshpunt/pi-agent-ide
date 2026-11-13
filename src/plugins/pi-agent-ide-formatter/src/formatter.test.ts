import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFormatter } from "./formatter.ts";
import { FormatterCommandRegistry } from "./registry.ts";

test("formatter dispatch retains the source owner through project selection and execution", async () => {
  const root = "ssh://formatter/srv/project";
  const filePath = `${root}/note.fixture`;
  const calls: string[] = [];
  const formatter = createFormatter({
    async resolveProject(source, cwd) {
      calls.push(source, cwd);
      return { cwd: root, external: true };
    },
    async loadRegistry(cwd) {
      calls.push(cwd);
      return FormatterCommandRegistry.fromConfig({
        version: 1,
        formatters: {
          owned: {
            extensions: [".fixture"],
            run: { command: ["owner-format", "{file}"] },
            output: "stdout",
          },
        },
      });
    },
    async run(config, project, source) {
      calls.push(config.run.command[0] ?? "", project, source);
      return { ok: true, changed: true };
    },
  });
  expect(await formatter.format({ filePath }, { cwd: "/controller/project" })).toEqual({
    ok: true,
    edits: 1,
    formatter: "owner-format",
  });
  expect(calls).toEqual([filePath, "/controller/project", root, "owner-format", root, filePath]);
});
test("formats Rust 2024 let chains using the crate edition", async () => {
  const root = path.resolve(".agents/tmp/formatter-rust-edition");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "crate-"));
  directories.push(cwd);
  const filePath = path.join(cwd, "src", "main.rs");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    path.join(cwd, "Cargo.toml"),
    '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2024"\n',
  );
  await writeFile(filePath, 'fn main(){if let Some(x)=Some(1) && x > 0 {println!("{x}");}}\n');

  expect(await createFormatter().format({ filePath }, { cwd })).toMatchObject({
    ok: true,
    edits: 1,
    formatter: "rustfmt",
  });
  expect(await readFile(filePath, "utf8")).toContain("if let Some(x) = Some(1)");
});
test("formats a nested workspace crate using its inherited edition", async () => {
  const root = path.resolve(".agents/tmp/formatter-rust-workspace");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "workspace-"));
  directories.push(cwd);
  const crate = path.join(cwd, "member");
  const filePath = path.join(crate, "src", "main.rs");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    path.join(cwd, "Cargo.toml"),
    '[workspace]\nmembers = ["member"]\n[workspace.package]\nedition = "2024"\n',
  );
  await writeFile(
    path.join(crate, "Cargo.toml"),
    '[package]\nname = "member"\nversion = "0.1.0"\nedition.workspace = true\n',
  );
  await writeFile(filePath, 'fn main(){if let Some(x)=Some(1) && x > 0 {println!("{x}");}}\n');
  expect(await createFormatter().format({ filePath }, { cwd })).toMatchObject({
    ok: true,
    edits: 1,
    formatter: "rustfmt",
  });
});

test.each(["2015", "2024"])("honors rustfmt config edition %s over Cargo", async (edition) => {
  const root = path.resolve(".agents/tmp/formatter-rust-config");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "crate-"));
  directories.push(cwd);
  const filePath = path.join(cwd, "src", "main.rs");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    path.join(cwd, "Cargo.toml"),
    '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2024"\n',
  );
  await writeFile(path.join(cwd, ".rustfmt.toml"), `edition = "${edition}"\n`);
  await writeFile(filePath, 'fn main(){if let Some(x)=Some(1) && x > 0 {println!("{x}");}}\n');
  expect(await createFormatter().format({ filePath }, { cwd })).toMatchObject({
    ok: edition === "2024",
    formatter: "rustfmt",
  });
});
test("uses Cargo edition when the nearest rustfmt config does not set it", async () => {
  const root = path.resolve(".agents/tmp/formatter-rust-nearest");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "crate-"));
  directories.push(cwd);
  const filePath = path.join(cwd, "src", "main.rs");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    path.join(cwd, "Cargo.toml"),
    '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2024"\n',
  );
  await writeFile(path.join(cwd, "rustfmt.toml"), 'edition = "2015"\n');
  await writeFile(path.join(cwd, "src", ".rustfmt.toml"), "max_width = 80\n");
  await writeFile(filePath, 'fn main(){if let Some(x)=Some(1) && x > 0 {println!("{x}");}}\n');
  expect(await createFormatter().format({ filePath }, { cwd })).toMatchObject({
    ok: true,
    edits: 1,
    formatter: "rustfmt",
  });
});
test("leaves a project-defined Rust formatter command unchanged", async () => {
  const root = path.resolve(".agents/tmp/formatter-rust-custom");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "crate-"));
  directories.push(cwd);
  const filePath = path.join(cwd, "example.rs");
  await writeFile(filePath, "original\n");
  await mkdir(path.join(cwd, ".pi", "pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi", "pi-agent-ide", "formatters.json"),
    JSON.stringify({
      version: 1,
      formatters: {
        rustfmt: {
          extensions: [".rs"],
          output: "in-place",
          run: {
            command: [
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
              "{file}",
              "custom",
            ],
          },
        },
      },
    }),
  );
  expect(await createFormatter().format({ filePath }, { cwd })).toMatchObject({
    ok: true,
    edits: 1,
  });
  expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(["custom"]);
});
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

test("uses an external project's local formatter and project directory", async () => {
  const root = path.resolve(".agents/tmp/formatter-external-project");
  await mkdir(root, { recursive: true });
  const currentProject = await mkdtemp(path.join(root, "current-"));
  const externalProject = await mkdtemp(path.join(root, "external-"));
  directories.push(currentProject, externalProject);
  const filePath = path.join(externalProject, "src", "example.fixture");
  const cwdRecord = path.join(externalProject, "formatter-cwd.txt");
  await mkdir(path.dirname(filePath), { recursive: true });
  await mkdir(path.join(externalProject, ".pi", "pi-agent-ide"), { recursive: true });
  await writeFile(filePath, "saved edit\n");
  await writeFile(
    path.join(externalProject, ".pi", "pi-agent-ide", "formatters.json"),
    JSON.stringify({
      version: 1,
      formatters: {
        local: {
          extensions: [".fixture"],
          run: {
            command: [
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], process.cwd())",
              cwdRecord,
            ],
          },
          output: "in-place",
        },
      },
    }),
  );

  expect(await createFormatter().format({ filePath }, { cwd: currentProject })).toMatchObject({
    ok: true,
    formatter: path.basename(process.execPath),
  });
  expect(await readFile(cwdRecord, "utf8")).toBe(externalProject);
});

test("does not apply a global formatter to an unrelated external file", async () => {
  const root = path.resolve(".agents/tmp/formatter-external-isolation");
  await mkdir(root, { recursive: true });
  const currentProject = await mkdtemp(path.join(root, "current-"));
  const externalDirectory = await mkdtemp(path.join(root, "unrelated-"));
  directories.push(currentProject, externalDirectory);
  const filePath = path.join(externalDirectory, "example.fixture");
  await writeFile(filePath, "saved edit\n");
  const leaked = path.join(externalDirectory, "leaked.txt");
  await mkdir(path.join(currentProject, ".pi", "pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(currentProject, ".pi", "pi-agent-ide", "formatters.json"),
    JSON.stringify({
      version: 1,
      formatters: {
        current: {
          extensions: [".fixture"],
          run: {
            command: [
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], 'leaked')",
              leaked,
            ],
          },
          output: "in-place",
        },
      },
    }),
  );

  expect(await createFormatter().format({ filePath }, { cwd: currentProject })).toEqual({
    ok: true,
    edits: 0,
    formatter: null,
  });
  await expect(readFile(leaked, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
test.each([false, true])(
  "reports a missing formatter separately from a failed command (configured=%s)",
  async (configured) => {
    const root = path.resolve(".agents/tmp/formatter-provenance");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    directories.push(cwd);
    const filePath = path.join(cwd, "example.fixture");
    await writeFile(filePath, "saved edit\n");
    const registry = FormatterCommandRegistry.fromConfig({
      version: 1,
      formatters: configured
        ? {
            wrapper: {
              extensions: [".fixture"],
              run: { command: [path.join(cwd, "missing-formatter"), "{file}"] },
              output: "in-place",
            },
          }
        : {},
    });
    vi.spyOn(FormatterCommandRegistry, "fromDirectory").mockResolvedValue(registry);
    expect(await createFormatter().format({ filePath }, { cwd })).toEqual(
      configured
        ? { ok: false, edits: 0, formatter: "missing-formatter" }
        : { ok: true, edits: 0, formatter: null },
    );
  },
);
