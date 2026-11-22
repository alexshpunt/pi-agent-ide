import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const forms = [
  ["uuid", "$issued-uuid:report"],
  ["result", "RESULT#$issued-uuid:report"],
  ["object", { id: "$issued-uuid:report" }],
  ["json", JSON.stringify({ id: "$issued-uuid:report" })],
] as const;

test("read-only report references refuse edits consistently before streamed text arrives and in Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = "export const value = 1;\n";
    await writeFile(path.join(cwd, "example.note"), source);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lint", "ide.lsp", "ide.formatter"] }),
    );
    const edits = forms.flatMap(([name, reference]) =>
      [false, true].map((scoped) => {
        const id = `${name}-${scoped ? "scoped" : "whole"}`;
        const prefix = `{"path":${JSON.stringify(reference)}${scoped ? ',"at":"broken"' : ""}`;
        const payload = ',"text":"changed"}';
        return { id, prefix, payload };
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "readonly-result-edits",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      timeoutMs: 120_000,
      extensions: [
        path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/diagnostics-tool.ts"),
        "builtin:codemode",
      ],
      tools: ["diagnostics", "read", "search", "replace", "codemode"],
      conversation: [
        assistantMessage([
          toolCall({ id: "report", name: "diagnostics", arguments: { path: "example.note" } }),
        ]),
        ...edits.map(({ id, prefix, payload }) =>
          assistantMessage([
            toolCall({
              id,
              name: "replace",
              argumentsJson: prefix + payload,
              chunks: { kind: "explicit", chunks: [prefix, payload] },
              delayMs: 1,
            }),
          ]),
        ),
        assistantMessage([
          toolCall({
            id: "script",
            name: "codemode",
            arguments: {
              code: `
const report = await tools.diagnostics({path: "example.note"});
if (!report) throw Error("Missing diagnostic report");
const reread = await tools.read({path: report});
const found = await tools.search({path: report, query: "FIXTURE42"});
if (!reread || found?.matches.length !== 1) throw Error("Report lost readable text");
for (const value of [report, reread, found, found.matches[0]]) {
  for (const scoped of [false, true]) {
    if (await tools.replace({path: value, ...(scoped ? {at: "broken"} : {}), text: "changed"}) !== null)
      throw Error("Read-only result granted edit authority");
  }
}
text("verified");`,
            },
            chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER },
          }),
        ]),
        assistantMessage([text("Done")]),
      ],
    }).run("Try editing a read-only diagnostics report using issued references.");
    expect(getToolExecution(run, "report").isError).toBe(false);
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
    for (const id of [
      ...edits.map((edit) => edit.id),
      ...Array.from({ length: 8 }, (_, i) => `script/${i + 4}`),
    ]) {
      const execution = getToolExecution(run, id);
      expect(execution.isError, id).toBe(true);
      // Stream-cut calls fail host validation before tool_result. Their saved message carries
      // the guard outcome; nested Codemode calls retain ordinary execution details.
      const details = (
        id.startsWith("script/")
          ? getToolExecutionDetails(execution)
          : getToolResultMessage(run, id).details
      ) as {
        code?: string;
        effect?: string;
        results?: { data?: { errors?: { code?: string }[] } }[];
      };
      expect(details.effect, id).toBe("not-applied");
      expect(details.code ?? details.results?.[0]?.data?.errors?.[0]?.code, id).toBe(
        "NO_EDITABLE_TEXT",
      );
    }
    expect(await readFile(path.join(cwd, "example.note"), "utf8")).toBe(source);
  });
}, 120_000);
