import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { afterAll, expect, test } from "vitest";
import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const restoreRunner = forceStandaloneIntegrationFile();
const extensions = createExtensionSet();
afterAll(async () => {
  restoreRunner();
  await extensions.dispose();
});

test("literal control escapes refuse without mutation, recover by issued anchors, and keep literal file text editable", async () => {
  await withTempWorkspace(async (cwd) => {
    const actual = "alpha\r\n\tbravo";
    const literal = "alpha\\r\\n\\tbravo";
    const before = `PREFIX\r\n${actual}\r\nSUFFIX\r\n${literal}\r\n`;
    const file = await createFixture(cwd, "fixture.txt", before);
    // Refuse a distinct selector, so its literal spelling is not present in the file.
    const refused = "PREFIX\\r\\nalpha\\r\\n\\tbravo";
    const steps = [
      {
        id: "refuse",
        name: "replace",
        arguments: { path: "fixture.txt", start: refused, text: "BAD" },
      },
      { id: "after-refusal", name: "read", arguments: { path: "fixture.txt" } },
      { id: "snapshot", name: "bash", arguments: { command: "cp fixture.txt after-refusal.bin" } },

      {
        id: "recover",
        name: "replace",
        arguments: {
          path: "fixture.txt",
          start: "$issued-anchor:refuse:2",
          end: "$issued-anchor:refuse:3",
          text: "recovered\n",
        },
      },
      {
        id: "literal",
        name: "replace",
        arguments: { path: "fixture.txt", start: literal, text: "literal-edited\n" },
      },
      {
        id: "actual",
        name: "replace",
        arguments: {
          path: "fixture.txt",
          start: "PREFIX\nrecovered",
          text: "character-edited\n",
        },
      },
    ];
    const result = await new PiIntegrationTest({
      testName: "literal-escape-refusal-recovery",
      isolateUserResources: true,
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename),
      extensions: [
        path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
        ...extensions.paths,
      ],
      tools: ["replace", "read", "bash"],
      conversation: [
        ...steps.map((step) =>
          assistantMessage(
            [toolCall({ ...step, chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } })],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([
          text("Done", { chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } }),
        ]),
      ],
    }).run("Exercise literal-escape refusal and recovery.");
    expect(getToolExecution(result, "refuse").isError).toBe(true);
    expect(getToolExecutionDetails(getToolExecution(result, "refuse"))).toMatchObject({
      effect: "not-applied",
      results: [{ data: { errors: [{ code: "missing" }] } }],
    });
    expect(getToolResultText(result, "refuse")).toContain(JSON.stringify(refused));
    expect(getToolResultText(result, "refuse")).toContain(JSON.stringify(`PREFIX\r\n${actual}`));
    const readBack = getToolResultText(result, "after-refusal");
    expect(readBack).toContain("PREFIX");
    expect(readBack).toContain(literal);
    expect(readBack).not.toContain("BAD");

    expect(getToolExecution(result, "snapshot").isError).toBe(false);
    await expect(readFile(path.join(cwd, "after-refusal.bin"))).resolves.toEqual(
      Buffer.from(before),
    );
    for (const id of ["recover", "literal", "actual"])
      expect(getToolExecution(result, id).isError, id).toBe(false);
    await expect(readFile(file, "utf8")).resolves.toBe(
      // Both literals exclude their existing CRLF; replacement CRLF is additional content.
      "character-edited\r\n\r\nSUFFIX\r\nliteral-edited\r\n\r\n",
    );
  });
});
