import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseFormattersConfig,
  parseLintersConfig,
  runConfiguredFormatter,
} from "./tool-config.js";

const root = path.resolve(".agents", "tmp", "tool-config-tests");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("versioned tool config", () => {
  it("rejects unversioned and incomplete configs", () => {
    expect(() => parseFormattersConfig({ formatters: {} })).toThrow("version");
    expect(() =>
      parseLintersConfig({ version: 1, linters: { broken: { extensions: [".ts"] } } }),
    ).toThrow("check");
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
