import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { getToolExecution, getToolExecutionDetails, getToolResultText } from "pi-coding-agent-test";
import { generateReadExtensions } from "pi-agent-read/testing";
import { afterAll, expect, test } from "vitest";

import {
  expectTextToolDiff,
  runTextToolScenario,
} from "#integration-tests/support/pi-runtime/scenario.ts";

const repoRoot = process.cwd();
const generatedExtensions = await generateReadExtensions([
  path.join(repoRoot, "tests/integration/extensions/pi-agent-text-editor/register-extension.ts"),
  path.join(
    repoRoot,
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  ),
  path.join(repoRoot, "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts"),
  path.join(repoRoot, "src/index.ts"),
  path.join(repoRoot, "src/plugins/pi-agent-ide-formatter/index.ts"),
]);
const tempRoot = path.join(repoRoot, ".tmp/pi-agent-ide-post-edit-formatter");

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});

test("editing an unformatted Rust file preserves unrelated formatting", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "src/main.rs";
    const before =
      'fn main(){\n    let value=1;\n    println!("a long line that deliberately keeps its non-rustfmt style: {}", value);\n}\n';
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(
      path.join(directory, "Cargo.toml"),
      '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2024"\n',
    );
    await writeFile(path.join(directory, fileName), before);
    const scenario = await runTextToolScenario({
      extensions: generatedExtensions.paths,
      cwd: directory,
      testName: "post-edit-rust-unformatted",
      tool: "replace",
      arguments: {
        path: fileName,
        start: formatLineHashAnchor(before, 2),
        text: "    let value=2;",
      },
    });
    expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
    expect(await readFile(path.join(directory, fileName), "utf8")).toBe(
      before.replace("let value=1;", "let value=2;"),
    );
    expect(
      getToolExecutionDetails(getToolExecution(scenario.result, scenario.mutationCallId)),
    ).toMatchObject({
      results: [
        {
          data: {
            formatting: { status: "skipped-style", formatter: "rustfmt" },
            diffStatuses: [
              expect.objectContaining({ formattingStatus: "skipped-style", formatter: "rustfmt" }),
            ],
          },
        },
      ],
    });
  });
}, 60_000);
test("formatting a Rust edit leaves child modules unchanged", async () => {
  await withTempDirectory(async (directory) => {
    const before = 'mod sub;\n\nfn main() {\n    println!("original");\n}\n';
    const child = 'pub fn child(){println!("unchanged");}\n';
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(
      path.join(directory, "Cargo.toml"),
      '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    await writeFile(path.join(directory, "src/main.rs"), before);
    await writeFile(path.join(directory, "src/sub.rs"), child);
    const scenario = await runTextToolScenario({
      extensions: generatedExtensions.paths,
      cwd: directory,
      testName: "post-edit-rust-child-module",
      tool: "replace",
      arguments: {
        path: "src/main.rs",
        start: formatLineHashAnchor(before, 4),
        text: '    println!( "changed" );',
      },
    });
    expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
    expect(await readFile(path.join(directory, "src/main.rs"), "utf8")).toBe(
      before.replace("original", "changed"),
    );
    expect(await readFile(path.join(directory, "src/sub.rs"), "utf8")).toBe(child);
  });
}, 60_000);
test("editing a Rust 2024 let chain formats the saved file", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "src/main.rs";
    const before =
      'fn main() {\n    if let Some(x) = Some(1)\n        && x > 0\n    {\n        println!("{x}");\n    }\n}\n';
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(
      path.join(directory, "Cargo.toml"),
      '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2024"\n',
    );
    await writeFile(path.join(directory, fileName), before);
    const scenario = await runTextToolScenario({
      extensions: generatedExtensions.paths,
      cwd: directory,
      testName: "post-edit-rust-2024",
      tool: "replace",
      arguments: {
        path: fileName,
        start: formatLineHashAnchor(before, 5),
        text: '        println!( "value={x}" );',
      },
    });
    expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
    expect(await readFile(path.join(directory, fileName), "utf8")).toContain(
      'println!("value={x}");',
    );
  });
}, 60_000);
test("an installed built-in does not format without project evidence", async () => {
  await withTempDirectory(async (directory) => {
    const bin = path.join(directory, "bin");
    const executable = path.join(bin, "gofmt");
    const fileName = "fixture.go";
    await mkdir(bin, { recursive: true });
    await writeFile(executable, '#!/bin/sh\nprintf "\\n// formatter-ran\\n" >> "$2"\n', "utf8");
    await chmod(executable, 0o755);
    await writeFile(path.join(directory, fileName), "package fixture\n\nvar Value = 1\n", "utf8");

    const scenario = await runTextToolScenario({
      extensions: generatedExtensions.paths,
      cwd: directory,
      testName: "post-edit-formatter-no-evidence",
      environment: { PATH: [bin, process.env.PATH ?? ""].join(path.delimiter) },
      tool: "replace",
      arguments: {
        path: fileName,
        start: formatLineHashAnchor("package fixture\n\nvar Value = 1\n", 3),
        text: "var Value=2",
      },
    });

    expect(await readFile(path.join(directory, fileName), "utf8")).toBe(
      "package fixture\n\nvar Value=2\n",
    );
    expect(getToolResultText(scenario.result, scenario.mutationCallId)).not.toContain(
      "formatter-ran",
    );
  });
}, 60_000);
test("an installed built-in formats when the project has matching evidence", async () => {
  await withTempDirectory(async (directory) => {
    const bin = path.join(directory, "bin");
    const executable = path.join(bin, "gofmt");
    const fileName = "fixture.go";
    await mkdir(bin, { recursive: true });
    await writeFile(executable, '#!/bin/sh\nprintf "\\n// formatter-ran\\n" >> "$2"\n', "utf8");
    await chmod(executable, 0o755);
    await writeFile(path.join(directory, "go.mod"), "module example.test/fixture\n", "utf8");
    await writeFile(path.join(directory, fileName), "package fixture\n\nvar Value = 1\n", "utf8");

    await runTextToolScenario({
      extensions: generatedExtensions.paths,
      cwd: directory,
      testName: "post-edit-formatter-with-evidence",
      environment: { PATH: [bin, process.env.PATH ?? ""].join(path.delimiter) },
      tool: "replace",
      arguments: {
        path: fileName,
        start: formatLineHashAnchor("package fixture\n\nvar Value = 1\n", 3),
        text: "var Value=2",
      },
    });

    expect(await readFile(path.join(directory, fileName), "utf8")).toContain("formatter-ran");
  });
}, 60_000);
test("an edit returns the formatter result instead of the requested intermediate text", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "formatter.ts";
    const before = "export const value = 1;\n";
    const requestedLine = "export const value={answer:2};";
    const formatted = "export const value = { answer: 2 };\n";
    const file = path.join(directory, fileName);
    const formatterScript = path.join(directory, "format.mjs");
    const agentDirectory = path.join(directory, "agent");
    const globalConfigDirectory = path.join(agentDirectory, "extensions", "pi-agent-ide");
    const projectConfigDirectory = path.join(directory, ".pi", "pi-agent-ide");
    await mkdir(globalConfigDirectory, { recursive: true });
    await mkdir(projectConfigDirectory, { recursive: true });

    await writeFile(
      formatterScript,
      [
        'import { readFile, writeFile } from "node:fs/promises";',
        "const file = process.argv[2];",
        'const source = await readFile(file, "utf8");',
        'await writeFile(file, source.replace("export const value={answer:2};", "export const value = { answer: 2 };"), "utf8");',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(globalConfigDirectory, "formatters.json"),
      JSON.stringify({
        version: 1,
        formatters: {
          fixture: {
            extensions: [".ts"],
            run: { command: ["node", formatterScript, "{file}"] },
            output: "in-place",
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(projectConfigDirectory, "lsp-servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          "fixture-formatter": {
            command: ["node", "--version"],
            rootMarkers: ["lsp-servers.json"],
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: [],
          },
        },
      }),
      "utf8",
    );
    await writeFile(file, before, "utf8");

    const scenario = await runTextToolScenario({
      extensions: generatedExtensions.paths,
      cwd: directory,
      testName: "post-edit-formatter",

      isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agentDirectory },
      tool: "replace",
      arguments: {
        path: fileName,
        start: formatLineHashAnchor(before, 1),
        text: requestedLine,
      },
    });

    expect(scenario.result.tuiRenderedOutput).not.toContain("Event handler error");

    expect(await readFile(file, "utf8")).toBe(formatted);
    expectTextToolDiff(scenario, fileName, before, formatted);
    expect(
      getToolExecutionDetails(getToolExecution(scenario.result, scenario.mutationCallId)),
    ).toMatchObject({
      results: [{ data: { formatting: { status: "changed", formatter: "node" } } }],
    });
    expect(scenario.result.tuiRenderedOutput).toContain("(node)");

    const output = getToolResultText(scenario.result, scenario.mutationCallId);
    expect(output).toContain("export const value = { answer: 2 };");
    expect(output).not.toContain(requestedLine);
  });
}, 60_000);

test.skipIf(process.platform !== "win32" || !process.env.PI_TEST_WSL_FORMATTER_PROJECT)(
  "Windows edits a WSL project without selecting its POSIX-only formatter shim",
  async () => {
    const project = process.env.PI_TEST_WSL_FORMATTER_PROJECT!;
    const shim = path.join(project, "node_modules", ".bin", "oxfmt");
    expect(await readFile(shim, "utf8")).toContain("#!/bin/sh");
    await expect(readFile(`${shim}.cmd`)).rejects.toMatchObject({ code: "ENOENT" });
    const directory = await mkdtemp(path.join(project, ".tmp", "lpt1450-edit-"));
    const file = path.join(directory, "fixture.ts");
    const before = "export const value = 1;\n";
    try {
      await writeFile(file, before);
      const scenario = await runTextToolScenario({
        extensions: generatedExtensions.paths,
        cwd: project,
        testName: "windows-wsl-posix-formatter",
        environment: { PATH: path.dirname(process.execPath) },
        tool: "replace",
        arguments: {
          path: file,
          start: formatLineHashAnchor(before, 1),
          text: "export const value = 2;",
        },
      });
      expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
      expect(await readFile(file, "utf8")).toBe("export const value = 2;\n");
      expect(getToolResultText(scenario.result, scenario.mutationCallId)).toContain(
        "No formatter is available for this file.",
      );
      expect(
        getToolExecutionDetails(getToolExecution(scenario.result, scenario.mutationCallId)),
      ).toMatchObject({
        results: [{ data: { formatting: { status: "unavailable" } } }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, "project-"));

  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
