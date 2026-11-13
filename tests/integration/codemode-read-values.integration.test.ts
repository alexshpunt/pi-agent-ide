import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const json = '{\r\n  "name": "fixture",\r\n  "items": [1, 2, 3]\r\n}';
const long = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
// Long enough for the ast view to mark the function's scope.
const scoped = `export function one() {\n${["a", "b", "c", "d", "e"].map((name, index) => `  const ${name} = ${index};\n`).join("")}  return a + b + c + d + e;\n}\n`;
const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 7) % 256));

async function run(cwd: string, code: string) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  await writeFile(path.join(cwd, "data.json"), json);
  await writeFile(path.join(cwd, "long.txt"), long);
  await writeFile(path.join(cwd, "bytes.bin"), bytes);
  await writeFile(path.join(cwd, "code.ts"), scoped);
  await mkdir(path.join(cwd, "folder/sub"), { recursive: true });
  await writeFile(path.join(cwd, "folder/a.txt"), "alpha\n");
  return new PiIntegrationTest({
    testName: "codemode-read-values",
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "write", "codemode"],
    conversation: [
      assistantMessage([toolCall({ id: "script", name: "codemode", arguments: { code } })], {
        stopReason: "toolUse",
      }),
      assistantMessage(
        [
          toolCall({
            id: "direct-list",
            name: "read",
            arguments: { path: ["folder/a.txt", "missing.txt"] },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Read text, bytes, directories and several paths in Codemode");
}

test("Codemode Read values carry exact text, bytes, entries and per-path results", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await run(
      cwd,
      String.raw`
const check = (condition, message) => { if (!condition) throw Error(message); };
const data = await tools.read({ path: "data.json" });
check(Object.keys(data).sort().join() === "id,text", "keys: " + Object.keys(data));
check(JSON.parse(data.text).items.length === 3, "JSON.parse failed");
check(data.id.startsWith("RESULT#"), "id: " + data.id);
await tools.write({ path: "copy.txt", content: data.text });
const whole = await tools.read({ path: "long.txt" });
check(whole.text.split("\n").length === 3001, "whole lines: " + whole.text.split("\n").length);
const window = await tools.read({ path: "long.txt", offset: 2999, limit: 5 });
check(window.text === "line 2999\nline 3000\n", "window: " + JSON.stringify(window.text));
const page = await tools.read({ path: "long.txt", offset: 10, limit: 2 });
check(page.text === "line 10\nline 11\n", "page: " + JSON.stringify(page.text));
const byValue = await tools.search({ path: page, query: "line 1" });
const byId = await tools.search({ path: page.id, query: "line 11" });
check(byValue.matches.length > 0 && byId.matches.length > 0, "search by value or id");
const inside = await tools.search({ path: page, query: "regex:^line 1\\d$" });
// The value selects only its window: lines 10 and 11, not line 12.
check(inside.matches.map((match) => match.path + ":" + match.line).join() === "long.txt:10,long.txt:11", "the value selects its window: " + JSON.stringify(inside));
const anchored = await tools.read({ path: "long.txt", limit: 2, views: ["anchors"] });
check(/^\w+\|line 1\n\w+\|line 2$/u.test(anchored.text), "anchors: " + JSON.stringify(anchored.text));
const jq = await tools.read({ path: "data.json", views: ["jq:.items"] });
check(JSON.stringify(JSON.parse(jq.text)) === "[1,2,3]", "jq: " + JSON.stringify(jq.text));
const scopes = await tools.read({ path: "code.ts", views: ["ast"] });
check(/^export function one\(\) \{  <!-- scope-begin-(\w+) -->\n[\s\S]*\n\}  <!-- scope-end-\1 -->\n$/u.test(scopes.text), "ast: " + JSON.stringify(scopes.text));
const outline = await tools.read({ path: "ast:code.ts" });
check(outline.text.startsWith("## file: code.ts\n") && outline.text.includes("export function one()"), "outline: " + JSON.stringify(outline.text));
const raw = await tools.read({ path: "raw:bytes.bin" });
check(Object.keys(raw).join() === "bytes", "raw keys");
await tools.write({ path: "bytes.b64", content: raw.bytes });
const folder = await tools.read({ path: "folder" });
text("entries:" + JSON.stringify([...folder.entries].sort()));
const listed = await tools.read({ path: ["data.json", "missing.txt", page], limit: 1 });
check(Array.isArray(listed) && listed.length === 3, "array path: " + JSON.stringify(listed));
check(listed[0].text === "{\r\n" && listed[1] === null && listed[2].text === "line 10\n", JSON.stringify(listed));
const again = await tools.search({ path: listed[2], query: "line 10" });
check(again.matches.length === 1, "an array item's id selects its window");
text("done");
`,
    );

    const output = getToolResultText(result, "script");
    expect(getToolExecution(result, "script").isError, output).toBe(false);
    expect(output).toContain("done");
    expect(await readFile(path.join(cwd, "copy.txt"))).toEqual(Buffer.from(json));
    expect(await readFile(path.join(cwd, "bytes.b64"), "utf8")).toBe(bytes.toString("base64"));
    expect(output).toContain('entries:["a.txt","sub/"]');
    const failures = codemodeFailures(output);
    expect(failures).toContain("1 of");
    expect(failures).toContain("missing.txt");
    expect(failures).not.toContain("line 10");

    // A direct Read of several paths shows each result under its path, failures included.
    const direct = getToolResultText(result, "direct-list");
    expect(getToolExecution(result, "direct-list").isError).toBe(true);
    expect(direct).toMatch(
      /--- folder\/a\.txt ---\nalpha\n[\s\S]*--- missing\.txt ---\nRead failed/u,
    );
  });
});
