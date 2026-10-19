import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const tokens = [
  ["uuid", "$issued-uuid:source"],
  ["result", "$issued-result:source"],
  ["prefix", "RESULT#$issued-uuid:source"],
] as const;

async function runReferencePlan(
  cwd: string,
  name: string,
  steps: {
    id: string;
    name: string;
    arguments: Record<string, JsonValue>;
  }[],
  nativeCode = false,
) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await mkdir(path.join(cwd, ".pi-agent"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    transport: "rpc",
    rawMode: false,
    environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
    extensions: [
      path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
      path.resolve("src/pi-agent-ide.ts"),
      ...(nativeCode ? ["builtin:codemode"] : []),
    ],
    tools: ["read", "replace", ...(nativeCode ? ["codemode"] : [])],
    conversation: [
      ...steps.map((step) =>
        assistantMessage(
          [toolCall({ ...step, chunks: { kind: "fixed", size: 65536 }, delayMs: 0 })],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Done", { delayMs: 0 })]),
    ],
  }).run("Verify issued-reference dispatch with the offline fixture provider.");
}

for (const [form, token] of tokens) {
  test(`standalone ${form} rejects extra selectors before filesystem lookup`, async () => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
      const run = await runReferencePlan(cwd, `direct-reference-${form}`, [
        { id: "source", name: "read", arguments: { path: "note.txt", offset: 2, limit: 1 } },
        { id: "invalid", name: "replace", arguments: { path: token, start: "beta", text: "BAD" } },
        {
          id: "invalid-range",
          name: "replace",
          arguments: { path: token, start: "beta", end: "beta", text: "BAD" },
        },
        {
          id: "unknown",
          name: "replace",
          arguments: { path: "00000000-0000-0000-0000-000000000000", text: "UNKNOWN" },
        },
        { id: "valid", name: "replace", arguments: { path: token, text: "BETA\n" } },
        { id: "stale", name: "replace", arguments: { path: token, text: "STALE\n" } },
        {
          id: "path",
          name: "replace",
          arguments: { path: "note.txt", start: "gamma", text: "GAMMA" },
        },
        {
          id: "bad-anchor",
          name: "replace",
          arguments: { path: "note.txt", start: "2#FFFF", text: "DAMAGED" },
        },
      ]);
      expect(run.state?.model).toMatchObject({ provider: "scripted", id: "scripted-model" });
      expect(getToolExecution(run, "invalid").isError).toBe(true);
      expect(getToolExecution(run, "invalid-range").isError).toBe(true);
      expect(getToolResultText(run, "invalid-range")).toContain("RESULT_INPUT_REJECTED");
      expect(getToolResultText(run, "invalid")).toContain("RESULT_INPUT_REJECTED");
      expect(getToolResultText(run, "invalid")).not.toContain("ENOENT");
      expect(getToolExecution(run, "valid").isError, getToolResultText(run, "valid")).toBe(false);
      expect(getToolExecution(run, "stale").isError).toBe(true);
      expect(getToolExecution(run, "unknown").isError).toBe(true);
      expect(getToolExecution(run, "bad-anchor").isError).toBe(true);
      expect(getToolExecution(run, "path").isError, getToolResultText(run, "path")).toBe(false);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\nGAMMA\n");
    });
  });
}

test("native Codemode keeps the same issued-reference argument and selection boundaries", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    const run = await runReferencePlan(
      cwd,
      "native-reference-dispatch",
      [
        {
          id: "code",
          name: "codemode",
          arguments: {
            code: String.raw`
for (const [index, form] of ["uuid", "text", "prefix"].entries()) {
  const shown = await tools.read({ path: "note.txt", offset: 2, limit: 1 });
  const id = /<uuid>([^<]+)<\/uuid>/u.exec(shown)?.[1];
  if (!id) throw Error("Read did not issue a reference");
  const source = form === "text" ? shown : form === "uuid" ? id : "RESULT#" + id;
  for (const selector of [{ start: "beta" }, { start: "beta", end: "beta" }]) {
    let rejected = false;
    try { await tools.replace({ path: source, ...selector, text: "BAD" }); }
    catch (error) { rejected = String(error).includes("RESULT_INPUT_REJECTED"); }
    if (!rejected) throw Error("Unsupported reference-plus-selector call was not rejected");
  }
  await tools.replace({ path: source, text: "BETA" + index + "\n" });
  await tools.read({ path: "note.txt" });
  let stale = false;
  try { await tools.replace({ path: source, text: "STALE" }); }
  catch { stale = true; }
  if (!stale) throw Error("A changed snapshot still authorized an edit");
}
let unknown = false;
try { await tools.replace({ path: "00000000-0000-0000-0000-000000000000", text: "UNKNOWN" }); }
catch { unknown = true; }
if (!unknown) throw Error("An unknown reference authorized an edit");
await tools.replace({ path: "note.txt", start: "gamma", text: "GAMMA" });
text("Reference boundaries verified");
`,
          },
        },
      ],
      true,
    );
    expect(getToolExecution(run, "code").isError, getToolResultText(run, "code")).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA2\nGAMMA\n");
  });
});
