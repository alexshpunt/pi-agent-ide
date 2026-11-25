import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceError } from "pi-agent-ide/api/resource";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runAxi } from "#linear/axi.ts";
import { createLinearOperationBackend } from "#linear/operation-backend.ts";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "linear-axi-process-"));
  await mkdir(path.join(cwd, ".pi"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
/** A stand-in AXI executable; its behavior is the script body. */
async function axi(body: string) {
  const file = path.join(cwd, "axi.mjs");
  await writeFile(file, body);
  await writeFile(path.join(cwd, ".pi", "linear.json"), JSON.stringify({ axiPath: file }));
}

test("an AXI process stopped at its deadline reports the local timeout, not a generic failure", async () => {
  await axi("setInterval(() => {}, 1000);\n");
  await expect(runAxi(cwd, ["issues", "view", "ENG-1"], undefined, undefined, 300)).rejects.toThrow(
    /^LINEAR_AXI_TIMEOUT$/u,
  );
});

test("a mutation whose AXI process timed out keeps an unknown effect", async () => {
  await axi("setInterval(() => {}, 1000);\n");
  const backend = createLinearOperationBackend((dir, args, signal) =>
    runAxi(dir, args, signal, undefined, 300),
  );
  const error = await backend
    .invoke("example", "save_issue", { id: "ENG-1", state: "Done" }, cwd)
    .catch((value: unknown) => value);
  expect(error).toBeInstanceOf(ResourceError);
  expect(error).toMatchObject({ code: "LINEAR_AXI_TIMEOUT", effect: "unknown" });
});

test("a connection that never opened crosses the process boundary as not applied", async () => {
  await axi(
    [
      'process.stdout.write("error: LINEAR_OPERATION_CONNECT_FAILED\\n");',
      'process.stdout.write("effect: not-applied\\n");',
      "process.exitCode = 1;",
      "",
    ].join("\n"),
  );
  const error = await runAxi(cwd, ["comments", "create"]).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(ResourceError);
  expect(error).toMatchObject({ code: "LINEAR_OPERATION_CONNECT_FAILED", effect: "not-applied" });
});

test("unrecognized AXI output stays a generic failure without private text", async () => {
  await axi('process.stdout.write("error: private fetch failed\\n"); process.exitCode = 1;\n');
  await expect(runAxi(cwd, ["issues", "view", "ENG-1"])).rejects.toThrow(/^LINEAR_AXI_FAILED$/u);
});
