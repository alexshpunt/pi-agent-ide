import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFormatter } from "./formatter.js";
import { FormatterCommandRegistry } from "./registry.js";

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
