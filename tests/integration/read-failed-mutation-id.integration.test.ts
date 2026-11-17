import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionResult,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

test("Read failures name the issued mutation result, not its private target", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    const directory = ".tmp/move-rollback";
    await mkdir(path.join(cwd, directory), { recursive: true });
    const source = `${directory}/restored-source.txt`;
    const target = `${directory}/restored-target.txt`;
    const sourceContent = "head\nmove-me\nend\n";
    const targetContent = "top\nbottom\n";
    await writeFile(path.join(cwd, source), sourceContent);
    await writeFile(path.join(cwd, target), targetContent);
    const parameters = { path: source, start: "move-me", target, targetStart: "top" };
    const run = await new PiIntegrationTest({
      testName: "read-failed-mutation-id",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/support/move-rollback-resource.ts"),
      ],
      tools: ["move", "read", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "move",
              name: "codemode",
              arguments: {
                code: `const moved = await tools.move(${JSON.stringify(parameters)}); store("moved", moved); text(JSON.stringify({moveId:moved}));`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "reread",
              name: "codemode",
              arguments: {
                code: `const moved = load("moved"); for (const path of [{id:moved}, moved, [{id:moved}], moved.slice(7)]) { text(JSON.stringify({value:await tools.read({path})})); }`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Finished.")]),
      ],
    }).run("Observe the failed Move result without retrying it.");

    expect(getToolExecution(run, "move").isError).toBe(true);
    expect(getToolExecutionResult(run, "reread")).toMatchObject({
      details: {
        calls: [{ status: "error" }, { status: "error" }, { status: "error" }, { status: "error" }],
      },
    });
    const moveId = /\{"moveId":"([^"]+)"\}/u.exec(getToolResultText(run, "move"))?.[1];
    expect(moveId).toMatch(/^RESULT#[a-f\d-]{36}$/u);
    const reread = getToolResultText(run, "reread");
    expect(reread.match(/\{"value":null\}/gu)).toHaveLength(3);
    expect(reread.match(/\{"value":\[null\]\}/gu)).toHaveLength(1);
    const references = reread.match(/RESULT#[a-f\d-]{36}/gu) ?? [];
    expect(references.length).toBeGreaterThanOrEqual(3);
    expect(new Set(references)).toEqual(new Set([moveId]));
    expect(await readFile(path.join(cwd, source), "utf8")).toBe(sourceContent);
    expect(await readFile(path.join(cwd, target), "utf8")).toBe(targetContent);
  });
});
