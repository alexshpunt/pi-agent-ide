import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const code = `
  const first = tools.read({ path: "fixture:nested-a" });
  const second = tools.read({ path: "fixture:nested-b" });
  await tools.wait_for_reads({});
  await Promise.all([first, second, tools.unavailable_in_this_script({})]);
  await tools.read({ path: "fixture:dependent" });
`;

test("a failing Codemode script does not cancel independent reads in the same turn", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );

    const result = await new PiIntegrationTest({
      testName: "codemode-cancellation-boundary",
      rawMode: false,
      cwd,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/codemode-cancellation-boundary.ts"),
      ],
      tools: ["read", "codemode", "wait_for_reads"],
      conversation: [
        assistantMessage(
          [
            toolCall({ id: "failed-script", name: "codemode", arguments: { code } }),
            toolCall({ id: "direct-a", name: "read", arguments: { path: "fixture:direct-a" } }),
            toolCall({ id: "direct-b", name: "read", arguments: { path: "fixture:direct-b" } }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Make independent reads in parallel");

    const script = getToolExecution(result, "failed-script");
    expect(script.isError).toBe(true);
    expect(getToolExecution(result, "failed-script/3")).toMatchObject({
      toolName: "wait_for_reads",
      isError: false,
    });
    for (const id of ["direct-a", "direct-b"]) {
      expect(getToolExecution(result, id).isError).toBe(false);
      expect(getToolResultText(result, id)).toContain(`${id}-payload`);
    }

    expect(getToolExecutionDetails(script)).toMatchObject({
      calls: [
        { name: "read", status: "ok" },
        { name: "read", status: "ok" },
        { name: "wait_for_reads", status: "ok" },
      ],
    });
    for (const [index, id] of ["nested-a", "nested-b"].entries()) {
      expect(getToolExecution(result, `failed-script/${index + 1}`)).toMatchObject({
        isError: false,
        result: {
          content: expect.arrayContaining([
            { type: "text", text: expect.stringContaining(`${id}-payload`) },
          ]),
        },
      });
    }
  });
});
