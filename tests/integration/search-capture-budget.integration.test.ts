import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

test("Search refuses an oversized capture and Pi can still search and edit through Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "bundle.js"),
      "line ".repeat(160) + "x".repeat(256 * 1024) + "\n",
    );
    await writeFile(path.join(cwd, "task.txt"), "before\r\n");
    const scope = process.env.PI_SEARCH_CAPTURE_SCOPE ?? "bundle.js";
    const request = { query: "line anchors for edits", path: scope, limit: 10, multiline: false };
    const result = await new PiIntegrationTest({
      testName: "search-capture-budget",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      environment: { PI_CODING_AGENT_DIR: ".pi-agent" },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "replace", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "oversized", name: "search", arguments: request })], {
          stopReason: "toolUse",
        }),
        assistantMessage(
          [
            toolCall({
              id: "recover",
              name: "codemode",
              arguments: {
                code: `
const refused = await tools.search(${JSON.stringify(request)});
if (refused !== null) throw Error("Oversized capture was accepted");
const found = await tools.search({path:"task.txt",query:"before",limit:1});
if (found.complete !== true || found.matches.length !== 1) throw Error("Search did not recover");
if (await tools.replace({path:found.matches[0].id,text:"after"}) === null) throw Error("Edit failed");
text({refused:refused === null, count:found.matches.length, complete:found.complete});`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Search the installed-package-shaped scope, then narrow the search and edit task.txt");
    expect(getToolExecution(result, "oversized").isError).toBe(true);
    expect(getToolResultMessage(result, "oversized").details).toMatchObject({
      failure: { code: "RESOLVE_FAILED" },
    });
    expect(getToolResultMessage(result, "oversized").details).not.toHaveProperty("payload");
    expect(getToolExecution(result, "recover").isError, getToolResultText(result, "recover")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("after\r\n");
  });
});
