import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseFormattersConfig,
  parseLintersConfig,
  resolveToolConfigPaths,
  runConfiguredFormatter,
  runConfiguredProcess,
} from "./tool-config.js";

const root = path.resolve(".agents", "tmp", "tool-config-tests");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("versioned tool config", () => {
  it("keeps the written edit when an in-place formatter fails after writing", async () => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "failed-format-"));
    directories.push(directory);
    const file = path.join(directory, "source.txt");
    await writeFile(file, "invalid but saved edit\n");
    const result = await runConfiguredFormatter(
      {
        extensions: [".txt"],
        output: "in-place",
        run: {
          command: [
            process.execPath,
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], 'partial'); process.exit(2)",
            "{file}",
          ],
        },
      },
      { projectRoot: directory, filePath: file },
    );
    expect(result).toEqual({ ok: false, changed: false });
    expect(await readFile(file, "utf8")).toBe("invalid but saved edit\n");
  });

  it("cancels a running configured process", async () => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "cancel-process-"));
    directories.push(directory);
    const controller = new AbortController();
    const running = runConfiguredProcess(
      { command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] },
      {
        projectRoot: directory,
        filePath: path.join(directory, "source.ts"),
        signal: controller.signal,
      },
    );
    const rejected = expect(running).rejects.toThrow("aborted");
    controller.abort();
    await rejected;
  });
  it("resolves global overrides below the configured Pi agent directory", () => {
    expect(
      resolveToolConfigPaths("/project", "linters", {
        environment: { PI_CODING_AGENT_DIR: "/agent" },
      }).global,
    ).toBe(path.join("/agent", "extensions", "pi-agent-ide", "linters.json"));
  });
  it("rejects unversioned and incomplete configs", () => {
    expect(() => parseFormattersConfig({ formatters: {} })).toThrow("version");
    expect(() =>
      parseLintersConfig({ version: 1, linters: { broken: { extensions: [".ts"] } } }),
    ).toThrow("check");
  });

  it("runs a project-local executable that is absent from the process PATH", async () => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "local-executable-"));
    directories.push(directory);
    const bin = path.join(directory, "node_modules", ".bin");
    const executable = path.join(bin, "fixture-linter");
    const file = path.join(directory, "source.ts");
    await mkdir(bin, { recursive: true });
    await writeFile(executable, "#!/bin/sh\nprintf project-local", "utf8");
    await chmod(executable, 0o755);
    await writeFile(file, "export {};\n", "utf8");

    const result = await runConfiguredProcess(
      { command: ["fixture-linter", "{file}"] },
      { projectRoot: directory, filePath: file, env: { PATH: "/usr/bin:/bin" } },
    );

    expect(result).toMatchObject({ ok: true, stdout: "project-local" });
  });

  it.runIf(process.platform === "win32")("runs npm command shims on Windows", async () => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "case-"));
    directories.push(directory);
    const file = path.join(directory, "source.txt");
    const shim = path.join(directory, "lint-shim.cmd");
    await writeFile(file, "source\n", "utf8");
    await writeFile(shim, "@echo off\r\necho %*\r\n", "utf8");

    const result = await runConfiguredProcess(
      { command: ["lint-shim", "{file}"] },
      {
        projectRoot: directory,
        filePath: file,
        env: { PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe(`"${file}"`);
  });

  it("runs direct argv with placeholders and stdout output", async () => {
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "case-"));
    directories.push(directory);
    const file = path.join(directory, "source.txt");
    const script = path.join(directory, "format.mjs");
    await writeFile(file, "before\n", "utf8");
    await writeFile(
      script,
      "import { readFile } from 'node:fs/promises'; process.stdout.write((await readFile(process.argv[2], 'utf8')).toUpperCase());\n",
      "utf8",
    );

    const result = await runConfiguredFormatter(
      {
        extensions: [".txt"],
        run: { command: [process.execPath, script, "{file}"] },
        output: "stdout",
      },
      { projectRoot: directory, filePath: file },
    );

    expect(result).toEqual({ ok: true, changed: true });
    expect(await readFile(file, "utf8")).toBe("BEFORE\n");
  });
});
