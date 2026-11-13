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

type Call = Parameters<typeof toolCall>[0];

const unknownId = "RESULT#00000000-0000-4000-8000-000000000000";

async function run(cwd: string, calls: readonly Call[]) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  for (const name of ["a", "a-id"]) await writeFile(path.join(cwd, `${name}.txt`), "alpha\nbeta\n");
  for (const name of ["c", "c-id"]) await writeFile(path.join(cwd, `${name}.txt`), "one\ngamma\n");
  return new PiIntegrationTest({
    testName: "codemode-source-values",
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "replace", "diff", "codemode"],
    conversation: [
      ...calls.map((call) => assistantMessage([toolCall(call)], { stopReason: "toolUse" })),
      assistantMessage([text("Done")]),
    ],
  }).run("Pass IDE values with an id to source parameters");
}

test("a value with an id selects the same text as its id, directly and in Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await run(cwd, [
      {
        id: "search",
        name: "codemode",
        arguments: {
          code: `
const read = await tools.read({ path: "a.txt" });
const readValue = { ...read, path: "c.txt" };
const byValue = await tools.search({ path: readValue, query: "beta" });
const byId = await tools.search({ path: read.id, query: "beta" });
const other = await tools.read({ path: "c.txt" });
const listed = await tools.search({ path: [readValue, { id: other.id }], query: "regex:a$" });
const compared = await tools.diff({ before: readValue, after: "a.txt" });
// The value's own path names another file; only its id counts, so both sides are equal.
const equal = typeof compared === "string" && !/^[+-](?![+-])/mu.test(compared);
const same = (a, b) => a.path === b.path && a.line === b.line && a.text === b.text;
text("search:" + JSON.stringify([byValue.matches.length === 1, same(byValue.matches[0], byId.matches[0]), listed.matches.length === 3, equal]));`,
        },
      },
      {
        id: "replace",
        name: "codemode",
        arguments: {
          code: `
const pair = async (a, c) => [
  await tools.search({ path: a, query: "beta" }),
  await tools.read({ path: c, offset: 2, limit: 1 }),
];
const [search, window] = await pair("a.txt", "c.txt");
const byValue = await tools.replace({
  path: [search, { ...window, text: "x" }],
  text: "done",
});
const [searchId, windowId] = await pair("a-id.txt", "c-id.txt");
const byId = await tools.replace({ path: [searchId.id, windowId.id], text: "done" });
text("replace:" + (byValue !== null) + ":" + (byId !== null));`,
        },
      },
      {
        id: "unknown",
        name: "codemode",
        arguments: {
          code: `const unknown = await tools.read({ path: { id: "${unknownId}" } });
const named = await tools.search({ path: { id: "a.txt" }, query: "alpha" });
text("unknown:" + (unknown === null) + ":" + (named === null));`,
        },
      },
      { id: "direct", name: "read", arguments: { path: { id: unknownId, text: "alpha" } } },
    ]);

    const search = getToolResultText(result, "search");
    expect(getToolExecution(result, "search").isError, search).toBe(false);
    expect(search).toContain("search:[true,true,true,true]");
    expect(codemodeFailures(search)).toBe("");

    const replace = getToolResultText(result, "replace");
    expect(replace).toContain("replace:true:true");
    expect(codemodeFailures(replace)).toBe("");
    const contents = async (name: string) => readFile(path.join(cwd, name), "utf8");
    expect(await contents("a.txt")).not.toBe("alpha\nbeta\n");
    expect(await contents("c.txt")).not.toBe("one\ngamma\n");
    expect(await contents("a.txt")).toBe(await contents("a-id.txt"));
    expect(await contents("c.txt")).toBe(await contents("c-id.txt"));

    const unknown = getToolResultText(result, "unknown");
    expect(unknown).toContain("unknown:true:true");
    const block = codemodeFailures(unknown);
    expect(block).toContain(`- read ${unknownId}`);
    expect(block).toContain("- search a.txt");
    expect(block.match(/Result reference expired or unknown/gu)).toHaveLength(2);

    const direct = getToolResultText(result, "direct");
    expect(getToolExecution(result, "direct").isError).toBe(true);
    expect(direct).toContain("Result reference expired or unknown");
  });
});
