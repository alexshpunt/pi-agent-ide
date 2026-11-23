import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

test.each([false, true])(
  "direct whole Search scope edits one issued match (range: %s)",
  async (paired) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "tokens.txt"), "red blue\n");
      const run = await new PiIntegrationTest({
        testName: `token-search-direct-${paired}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [
          path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
          path.resolve("src/pi-agent-ide.ts"),
        ],
        tools: ["search", "replace"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "search",
                name: "search",
                arguments: { path: "tokens.txt", query: "red OR blue" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "replace",
                name: "replace",
                arguments: {
                  path: { id: "$issued-uuid:search" },
                  ...(paired
                    ? {
                        from: "$issued-searchmatch:search:1",
                        through: "$issued-searchmatch:search:1",
                      }
                    : { at: "$issued-searchmatch:search:1" }),
                  text: "RED",
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Replace only the first issued Search match");
      expect(getToolExecution(run, "replace").isError, getToolResultText(run, "replace")).toBe(
        false,
      );
      expect(await readFile(path.join(cwd, "tokens.txt"), "utf8")).toBe("RED blue\n");
    });
  },
);
test("direct Search anchor refusals distinguish bulk token selections from word hints", async () => {
  await withTempWorkspace(async (cwd) => {
    const cases = [
      {
        id: "boolean",
        query: "red AND blue",
        content: "red blue\n",
        anchor: "$issued-searchallmatch:boolean",
        code: "search-token-selection",
      },
      {
        id: "words",
        query: "const x = await f",
        content: "const alpha\nawait beta\n",
        anchor: "$issued-searchmatch:words:1",
        code: "search-word-hint",
      },
    ];
    for (const { id, content } of cases) {
      await writeFile(path.join(cwd, `${id}.txt`), content);
    }
    const run = await new PiIntegrationTest({
      testName: "token-search-anchor-refusals",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
        path.resolve("src/pi-agent-ide.ts"),
      ],
      tools: ["search", "replace"],
      conversation: [
        ...cases.flatMap(({ id, query, anchor }) => [
          assistantMessage(
            [toolCall({ id, name: "search", arguments: { path: `${id}.txt`, query } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: `replace-${id}`,
                name: "replace",
                arguments: { path: `${id}.txt`, at: anchor, text: "BAD" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
        ]),
        assistantMessage([text("Done")]),
      ],
    }).run("Attempt an edit through each refused Search anchor");

    for (const { id, code, content } of cases) {
      const callId = `replace-${id}`;
      expect(
        getToolExecutionDetails(getToolExecution(run, callId)),
        getToolResultText(run, callId),
      ).toMatchObject({
        effect: "not-applied",
        results: [{ ok: false, errors: [{ code }] }],
      });
      expect(await readFile(path.join(cwd, `${id}.txt`), "utf8")).toBe(content);
    }
  });
});

test("token search selections cannot silently rewrite every match", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, "words.txt"), "const alpha\nawait beta\n");
    await writeFile(path.join(cwd, "boolean.txt"), "red blue\n");
    await writeFile(path.join(cwd, "literal.txt"), 'call("a b", 1);\n');
    const code = `
function check(v, message) { if (!v) throw Error(message); }
const result = await tools.search({path:"words.txt",query:"const x = await f"});
const found = result.fallback;
check(found.mode === "words" && found.matches.length > 1,"word fallback");
check(Object.keys(found).sort().join() === "complete,id,matches,mode", "compact fallback value");
check(await tools.replace({path:found,text:"BAD"}) === null,"whole value must fail");
check(await tools.replace({path:found.id,text:"BAD"}) === null,"whole id must fail");
check(await tools.read({path:found}) !== null,"whole selection is readable");
check(await tools.copy({path:found,target:"literal.txt",targetAfter:"end"}) === null,"bulk transfer must fail");
const scoped = await tools.search({path:found,query:"const"});
check(scoped.matches.length === 1,"read-only search scope");
check(await tools.replace({path:found.matches[0],text:"CONST"}) === null,"word hint match must fail");
check(await tools.replace({path:"words.txt",at:found.matches[0],text:"BAD"}) === null,"word hint anchor must fail");
const bool = await tools.search({path:"boolean.txt",query:"red AND blue"});
check(await tools.replace({path:bool,text:"BAD"}) === null,"boolean bulk");
check(await tools.replace({path:bool,from:bool.matches[0],through:bool.matches[0],text:"RED"}) !== null,"boolean scoped match");
const literal = await tools.search({path:"literal.txt",query:'call("a b", 1);'});
check(literal.matches.length === 1 && literal.matches[0].text === 'call("a b", 1);',"quotes stay literal");
check(await tools.replace({path:literal,text:"replaced"}) !== null,"literal result");
text("done");`;
    const run = await new PiIntegrationTest({
      testName: "token-search-edit",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      transport: "rpc",
      rawMode: false,
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "replace", "read", "copy", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "direct",
              name: "search",
              arguments: { path: "words.txt", query: "const x = await f" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([toolCall({ id: "compose", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Safely edit Search results");
    expect(getToolExecution(run, "compose").isError, getToolResultText(run, "compose")).toBe(false);
    expect(await readFile(path.join(cwd, "words.txt"), "utf8")).toBe("const alpha\nawait beta\n");
    expect(await readFile(path.join(cwd, "boolean.txt"), "utf8")).toBe("RED blue\n");
    expect(await readFile(path.join(cwd, "literal.txt"), "utf8")).toBe("replaced\n");
  });
});
