import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { PiRun } from "pi-coding-agent-test/base";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";

test("late diagnostic summaries keep direct and nested edit owners across deferred finalization", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
    const run = await new PiIntegrationTest({
      testName: "linked-diagnostic-owners",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [
        "builtin:codemode",
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/linked-diagnostics.ts"),
      ],
      tools: ["codemode", "write", "replace", "release_linked_diagnostics"],
      conversation: [
        call("first-edit", "write", { path: "direct.note", content: "old-direct" }),
        call("nested-edit", "codemode", {
          code: 'await tools.write({path:"nested.note",content:"before"}); await tools.replace({path:"nested.note",start:"before",text:"after"});',
        }),
        call("latest-edit", "write", { path: "direct.note", content: "latest-direct" }),
        call("release", "release_linked_diagnostics", {}),
        assistantMessage([text("Reports arrived after editing.")]),
      ],
    }).run("Edit files and release their delayed diagnostic checks.");
    for (const id of ["first-edit", "nested-edit", "latest-edit", "release"])
      expect(getToolExecution(run, id).isError).toBe(false);
    expect(await readFile(path.join(cwd, "direct.note"), "utf8")).toBe("latest-direct");
    expect(await readFile(path.join(cwd, "nested.note"), "utf8")).toBe("after");
    const owners = (await readFile(path.join(cwd, "edit-owners.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            file: string;
            content: string;
            parentToolCallId: string;
            postProcessing: string;
          },
      );
    expect(owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "direct.note",
          content: "old-direct",
          parentToolCallId: "first-edit",
        }),
        expect.objectContaining({
          file: "direct.note",
          content: "latest-direct",
          parentToolCallId: "latest-edit",
        }),
        expect.objectContaining({
          file: "nested.note",
          content: "before",
          parentToolCallId: "nested-edit",
        }),
        expect.objectContaining({
          file: "nested.note",
          content: "after",
          parentToolCallId: "nested-edit",
          postProcessing: "final",
        }),
      ]),
    );
    const saved = await PiRun.open(run.artifacts.run);
    const entries = (saved.session ?? "")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            customType?: string;
            data?: { parentToolCallId?: string; files: { filePath: string }[] };
          },
      );
    const summaries = entries.filter(
      (entry) => entry.type === "custom" && entry.customType === "ide-diagnostic-summary",
    );
    expect(summaries.map((entry) => entry.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentToolCallId: "latest-edit",
          files: [expect.objectContaining({ filePath: "direct.note" })],
        }),
        expect.objectContaining({
          parentToolCallId: "nested-edit",
          files: [expect.objectContaining({ filePath: "nested.note" })],
        }),
      ]),
    );
    expect(summaries).toHaveLength(2);
    expect(
      entries.filter(
        (entry) => entry.type === "custom_message" && entry.customType === "ide-diagnostics",
      ),
    ).toHaveLength(1);
    expect(run.tuiRenderedOutput).toContain("(owned-checker)");
    expect(getToolResultText(run, "first-edit")).not.toContain("owned-checker");
  });
});
