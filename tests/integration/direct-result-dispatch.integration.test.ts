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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

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
        assistantMessage([toolCall({ ...step, delayMs: 0 })], { stopReason: "toolUse" }),
      ),
      assistantMessage([text("Done", { delayMs: 0 })]),
    ],
  }).run("Verify issued-reference dispatch with the offline fixture provider.");
}

for (const [form, token] of tokens) {
  test(`standalone ${form} scopes selectors to its selection before filesystem lookup`, async () => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
      // A missed exact-text anchor blocks exact text in that file, so the misses come last.
      const again = token.replace(":source", ":again");
      const run = await runReferencePlan(cwd, `direct-reference-${form}`, [
        { id: "source", name: "read", arguments: { path: "note.txt", offset: 2, limit: 1 } },
        {
          id: "unknown",
          name: "replace",
          arguments: { path: "00000000-0000-0000-0000-000000000000", text: "UNKNOWN" },
        },
        { id: "inside", name: "replace", arguments: { path: token, start: "bet", text: "BET" } },
        { id: "stale", name: "replace", arguments: { path: token, text: "STALE\n" } },
        {
          id: "path",
          name: "replace",
          arguments: { path: "note.txt", start: "gamma", text: "GAMMA" },
        },
        { id: "again", name: "read", arguments: { path: "note.txt", offset: 2, limit: 1 } },
        { id: "outside", name: "replace", arguments: { path: again, start: "GAMMA", text: "BAD" } },
        {
          id: "outside-range",
          name: "replace",
          arguments: { path: again, start: "alpha", end: "BETa", text: "BAD" },
        },
        {
          id: "bad-anchor",
          name: "replace",
          arguments: { path: "note.txt", start: "ZZZZZZZ", text: "DAMAGED" },
        },
      ]);
      expect(run.state?.model).toMatchObject({ provider: "scripted", id: "scripted-model" });
      for (const id of ["outside", "outside-range"]) {
        expect(getToolExecution(run, id).isError).toBe(true);
        expect(getToolResultText(run, id)).toContain("The result selects note.txt line 2.");
        expect(getToolResultText(run, id)).not.toContain("ENOENT");
      }
      expect(getToolExecution(run, "inside").isError, getToolResultText(run, "inside")).toBe(false);
      expect(getToolExecution(run, "stale").isError).toBe(true);
      expect(getToolExecution(run, "unknown").isError).toBe(true);
      expect(getToolExecution(run, "bad-anchor").isError).toBe(true);
      expect(getToolExecution(run, "path").isError, getToolResultText(run, "path")).toBe(false);
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETa\nGAMMA\n");
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
for (const [index, form] of ["uuid", "value", "prefix"].entries()) {
  const shown = await tools.read({ path: "note.txt", offset: 2, limit: 1 });
  const id = /^RESULT#([a-f\d-]{36})$/u.exec(shown?.id)?.[1];
  if (!id) throw Error("Read did not issue a reference");
  const source = form === "value" ? shown : form === "uuid" ? id : "RESULT#" + id;
  const anchors = (await tools.read({ path: "note.txt", views: ["anchors"] })).text
    .split("\n")
    .map((line) => line.split("|")[0]);
  // A refused call resolves to null; the Codemode result lists each reason. Only line 2 is inside.
  for (const selector of [{ start: anchors[2] }, { start: anchors[0], end: anchors[1] }])
    if ((await tools.replace({ path: source, ...selector, text: "BAD\n" })) !== null)
      throw Error("A selector outside the result was not rejected");
  if ((await tools.replace({ path: source, start: anchors[1], text: "BETA" + index + "\n" })) === null)
    throw Error("A selector inside the result was rejected");
  await tools.read({ path: "note.txt" });
  if ((await tools.replace({ path: source, text: "STALE" })) !== null)
    throw Error("A changed snapshot still authorized an edit");
}
if ((await tools.replace({ path: "00000000-0000-0000-0000-000000000000", text: "UNKNOWN" })) !== null)
  throw Error("An unknown reference authorized an edit");
await tools.replace({ path: "note.txt", start: "gamma", text: "GAMMA" });
text("Reference boundaries verified");
`,
          },
        },
      ],
      true,
    );
    const output = getToolResultText(run, "code");
    expect(getToolExecution(run, "code").isError, output).toBe(false);
    const failures = codemodeFailures(output).split("\n- ").slice(1);
    expect(failures, output).toHaveLength(10);
    for (const [index, failure] of failures.slice(0, 9).entries())
      if (index % 3 < 2)
        expect(failure).toContain("outside the result's selection: note.txt line 2");
      else expect(failure).toContain("expired after its snapshot changed");
    expect(failures[9]).toMatch(/^replace 00000000-0000-0000-0000-000000000000\n/u);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA2\nGAMMA\n");
  });
});
