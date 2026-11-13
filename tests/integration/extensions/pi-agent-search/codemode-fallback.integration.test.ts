import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, onTestFinished, test } from "vitest";

test("Codemode separates broadened matches and keeps notices even when the script discards its value", async () => {
  const root = path.resolve(".tmp/codemode-fallback");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "input.txt"), "alpha alone\nbeta alone\n");
  const code = `
const found = await tools.search({path:"input.txt",query:"alpha beta"});
if (!found || !found.complete || found.matches.length || found.id) throw Error("Original was not empty: " + JSON.stringify(found));
if (found.fallback?.mode !== "words" || !found.fallback.complete || found.fallback.matches.length !== 2 || !found.fallback.id) throw Error("Missing fallback: " + JSON.stringify(found));
const selected = await tools.read({path:found.fallback.matches[0].id});
if (!selected.text.includes("alpha")) throw Error("Fallback id did not select its match");
const scope = await tools.read({path:"input.txt"});
const scoped = await tools.search({path:scope,query:"a.ph."});
if (!scoped || scoped.matches.length || scoped.fallback?.mode !== "regex" || scoped.fallback.matches.length !== 1 || scoped.fallback.matches[0].text !== "alpha") throw Error("Scoped regex fallback was lost: " + JSON.stringify(scoped));
text("fallback contract passed");
`;
  const result = await new PiIntegrationTest({
    testName: "codemode-fallback",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["search", "read", "codemode"],
    timeoutMs: 120_000,
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "direct",
            name: "search",
            arguments: { path: "input.txt", query: "alpha beta" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([toolCall({ id: "script", name: "codemode", arguments: { code } })], {
        stopReason: "toolUse",
      }),
      assistantMessage([text("Done")]),
    ],
  }).run("Search the fixture directly and through Codemode");
  for (const id of ["direct", "script"])
    expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
  expect(getToolResultText(result, "direct")).toContain("Search fallback:");
  expect(getToolResultText(result, "script")).toContain("fallback contract passed");
  expect(getToolResultText(result, "script")).toContain("Search fallback:");
  expect(getToolResultText(result, "script")).toContain("separate tokens");
}, 150_000);
