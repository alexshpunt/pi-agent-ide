import {
  PiIntegrationTest,
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";

const available = (command: string, argument: string) =>
  spawnSync(command, [argument], { stdio: "ignore" }).status === 0;
/** Whether a program is on PATH, for language servers that reject `--version`. */
const installed = (command: string) =>
  spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;

interface Project {
  readonly directory: string;
  readonly name: string;
}

async function writeFixture(cwd: string, files: Record<string, string>) {
  for (const [source, content] of Object.entries(files)) {
    const file = path.join(cwd, source);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/** Search the repository root for one name declared in each of two independent projects. */
async function searchProjects(
  testName: string,
  projects: readonly Project[],
  files: (cwd: string) => Record<string, string>,
) {
  return withTempWorkspace(async (cwd) => {
    await writeFixture(cwd, files(cwd));
    const run = await new PiIntegrationTest({
      testName,
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename),
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["lsp_search"],
      rawMode: false,
      timeoutMs: 120_000,
      conversation: [
        ...projects.map(({ name }, index) =>
          assistantMessage(
            [toolCall({ id: `search-${index}`, name: "lsp_search", arguments: { query: name } })],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Find each declaration in the repository");
    return projects.map(({ directory, name }, index) => {
      const id = `search-${index}`;
      const execution = getToolExecution(run, id);
      expect(execution.isError, getToolResultText(run, id)).toBe(false);
      const { payload } = getToolExecutionDetails(execution) as {
        payload: {
          cwd: string;
          complete: boolean;
          hits: { source: string; role: string; matchedText: string }[];
        };
      };
      expect(payload.complete, `${name} complete`).toBe(true);
      return {
        directory,
        definitions: payload.hits
          .filter(({ role }) => role === "definition")
          .map(({ source, matchedText }) => ({
            source: path.relative(payload.cwd, source).split(path.sep).join("/"),
            text: matchedText,
          })),
      };
    });
  });
}

// The server learns a project from the files it has open, and Pi seeds it with the first file it
// meets. Swapping the directory names swaps which project that is.
const orders = [
  ["a-project", "b-project"],
  ["b-project", "a-project"],
] as const;

test.skipIf(!available("clangd", "--version")).each(orders)(
  "finds declarations in two C++ compilation databases when %s is listed first and %s second",
  async (first, second) => {
    const projects = [
      { directory: first, name: "FindInFirstDatabase" },
      { directory: second, name: "FindInSecondDatabase" },
    ];
    const found = await searchProjects("workspace-clangd-databases", projects, (cwd) =>
      Object.fromEntries(
        projects.flatMap(({ directory, name }) => {
          const seed = `${directory}/00-seed.cpp`;
          const target = `${directory}/target.cpp`;
          return [
            [seed, "int Seed() { return 0; }\n"],
            [target, `int ${name}() { return 1; }\n`],
            [
              `${directory}/compile_commands.json`,
              JSON.stringify(
                [seed, target].map((source) => ({
                  directory: path.join(cwd, directory),
                  file: path.join(cwd, source),
                  arguments: ["clang++", "-c", path.join(cwd, source)],
                })),
              ),
            ],
          ];
        }),
      ),
    );
    expect(found).toEqual(
      projects.map(({ directory, name }) => ({
        directory,
        definitions: [{ source: `${directory}/target.cpp`, text: name }],
      })),
    );
  },
  150_000,
);

test.skipIf(!available("gopls", "version") || !available("go", "version")).each(orders)(
  "finds declarations in two Go modules without a go.work when %s is listed first and %s second",
  async (first, second) => {
    const projects = [
      { directory: first, name: "FindInFirstModule" },
      { directory: second, name: "FindInSecondModule" },
    ];
    const found = await searchProjects("workspace-go-modules", projects, () =>
      Object.fromEntries(
        projects.flatMap(({ directory, name }) => [
          [`${directory}/go.mod`, `module example.com/${directory}\n\ngo 1.24\n`],
          [`${directory}/00-seed.go`, "package seed\n\nfunc Seed() int { return 0 }\n"],
          [`${directory}/target.go`, `package seed\n\nfunc ${name}() int { return 1 }\n`],
        ]),
      ),
    );
    expect(found).toEqual(
      projects.map(({ directory, name }) => ({
        directory,
        definitions: [{ source: `${directory}/target.go`, text: name }],
      })),
    );
  },
  150_000,
);

test
  .skipIf(!available("rust-analyzer", "--version") || !available("cargo", "--version"))
  .each(orders)(
  "finds declarations in two Cargo workspaces without a parent workspace when %s is listed first and %s second",
  async (first, second) => {
    const projects = [
      { directory: first, name: "find_in_first_workspace" },
      { directory: second, name: "find_in_second_workspace" },
    ];
    const found = await searchProjects("workspace-cargo-workspaces", projects, () =>
      Object.fromEntries(
        projects.flatMap(({ directory, name }) => [
          [
            `${directory}/Cargo.toml`,
            `[package]\nname = "${directory}"\nversion = "0.1.0"\nedition = "2021"\n`,
          ],
          [`${directory}/src/lib.rs`, "pub mod target;\npub fn seed() -> i32 {\n    0\n}\n"],
          [`${directory}/src/target.rs`, `pub fn ${name}() -> i32 {\n    1\n}\n`],
        ]),
      ),
    );
    expect(found).toEqual(
      projects.map(({ directory, name }) => ({
        directory,
        definitions: [{ source: `${directory}/src/target.rs`, text: name }],
      })),
    );
  },
  150_000,
);

test.skipIf(!installed("basedpyright-langserver") && !installed("pyright-langserver")).each(orders)(
  "finds declarations in two Python projects with their own pyproject.toml when %s is listed first and %s second",
  async (first, second) => {
    const projects = [
      { directory: first, name: "find_in_first_project" },
      { directory: second, name: "find_in_second_project" },
    ];
    const found = await searchProjects("workspace-python-projects", projects, () =>
      Object.fromEntries(
        projects.flatMap(({ directory, name }) => [
          [`${directory}/pyproject.toml`, `[project]\nname = "${directory}"\nversion = "0.1.0"\n`],
          [`${directory}/seed.py`, "def seed() -> int:\n    return 0\n"],
          [`${directory}/target.py`, `def ${name}() -> int:\n    return 1\n`],
        ]),
      ),
    );
    expect(found).toEqual(
      projects.map(({ directory, name }) => ({
        directory,
        definitions: [{ source: `${directory}/target.py`, text: name }],
      })),
    );
  },
  150_000,
);
