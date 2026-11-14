import { readFile, writeFile } from "node:fs/promises";
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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

test("retained multiline Search matches keep full context and remain editable after later searches", async () => {
  await withTempWorkspace(async (cwd) => {
    const original = "keep\r\nprefix first\r\nlast suffix\r\nkeep\r\n";
    await writeFile(path.join(cwd, "task.txt"), original);
    const run = await new PiIntegrationTest({
      testName: "search-retained-multiline-context",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "direct",
              name: "search",
              arguments: { path: "task.txt", query: "regex:first\\r\\nlast", multiline: true },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "retain",
              name: "codemode",
              arguments: {
                code: `
const first = await tools.search({path:"task.txt",query:"regex:first\\\\r\\\\nlast",multiline:true});
if (first.complete !== true || first.matches.length !== 1) throw Error("Unexpected matches");
const match = first.matches[0];
if (match.text !== "first\\r\\nlast" || match.lineText !== "prefix first\\r\\nlast suffix") throw Error("Lost context");
store("retained", match);
for (let index = 0; index < 5; index++) {
  const later = await tools.search({path:"task.txt",query:"keep"});
  if (later.complete !== true || later.matches.length !== 2) throw Error("Later search failed");
}
text(match.lineText);`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "edit",
              name: "codemode",
              arguments: {
                code: `
const match = load("retained");
if (await tools.replace({path:match.id,text:"NEW"}) === null) throw Error("Retained match is unusable");
text("NEW");`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Retain multiline Search context, search again, and edit the original match");
    for (const id of ["direct", "retain", "edit"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(getToolResultText(run, "retain")).toContain("prefix first\r\nlast suffix");
    expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe(
      "keep\r\nprefix NEW suffix\r\nkeep\r\n",
    );
  });
});
