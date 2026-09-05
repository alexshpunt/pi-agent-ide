import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { collectProjectFiles } from "./inventory.js";

test("tool configuration files are not treated as project source files", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "pi-agent-doctor-inventory-"));

  try {
    const config = path.join(project, ".pi", "pi-agent-ide", "linters.json");
    const source = path.join(project, "source.ts");
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, "{}", "utf8");
    await writeFile(source, "export {};\n", "utf8");

    expect(await collectProjectFiles(project)).toEqual([source]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
