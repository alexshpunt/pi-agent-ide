import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import spawn from "cross-spawn";
import { expect, test } from "vitest";

import {
  bundledAstGrepPath,
  localAstGrepCommand,
  probeLocalAstGrep,
} from "#src/ast-grep-binary.ts";
import { createAstDoctorPlugin } from "#src/doctor-plugin.ts";

test("ships an ast-grep that starts without one on the PATH", async () => {
  const bundled = bundledAstGrepPath();
  expect(bundled).toBeDefined();
  expect(existsSync(bundled ?? "")).toBe(true);
  const result = await probeLocalAstGrep(os.tmpdir(), { PATH: "" });
  expect(result).toMatchObject({ ok: true });
  expect(result.detail).toMatch(/ast-grep \d+\.\d+/u);
});

test("runs a structural search with the bundled binary under an empty PATH", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ast-grep-bundled-"));
  try {
    await writeFile(path.join(directory, "main.ts"), "console.log(1);\n", "utf8");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        localAstGrepCommand(),
        ["run", "--pattern", "console.log($A)", "--json=compact", "."],
        { cwd: directory, env: { PATH: "" }, stdio: ["ignore", "pipe", "inherit"] },
      );
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.once("error", reject);
      child.once("close", () => resolve(stdout));
    });
    expect(JSON.parse(output)).toMatchObject([{ text: "console.log(1)" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the doctor reports why ast-grep cannot start", async () => {
  const astDoctorPlugin = createAstDoctorPlugin(async () => ({
    ok: false,
    detail: "spawn ast-grep ENOENT",
  }));
  const checks: { id: string; run?: (context: unknown) => Promise<unknown> }[] = [];
  await astDoctorPlugin.setup({
    addSetupCheck: () => undefined,
    addCheck: (check: { id: string; run: (context: unknown) => Promise<unknown> }) =>
      checks.push(check),
  } as never);
  const context = {
    cwd: os.tmpdir(),
    env: {},
    files: [],
    detectedLanguageIds: new Set(["typescript"]),
  };
  const check = checks.find((candidate) => candidate.id === "ast-grep");
  expect(await check?.run?.(context)).toEqual([
    {
      status: "fail",
      message: "ast-grep cannot start; ast_search is not offered",
      detail: "spawn ast-grep ENOENT",
    },
  ]);
});
