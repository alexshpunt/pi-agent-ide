import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "./support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";

const extension = path.resolve("tests/integration/fixtures/semantic-search.ts");

test.each([false, true])(
  "real Pi exposes semantic search only with an index: %s",
  async (indexed) => {
    const root = path.resolve(".tmp/semantic-integration");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "project-"));
    try {
      if (indexed) await writeFile(path.join(cwd, ".semantic-test-index"), "ready");
      const result = await new PiIntegrationTest({
        testName: `semantic-${indexed}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [extension, "builtin:codemode", "builtin:tool-search"],
        tools: ["semantic_search", "codemode", "tool_search"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "script",
                name: "codemode",
                arguments: { code: 'text(await searchTools("semantic_search"));' },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          ...(indexed
            ? [
                assistantMessage(
                  [
                    toolCall({
                      id: "semantic",
                      name: "semantic_search",
                      arguments: { query: "example" },
                    }),
                  ],
                  { stopReason: "toolUse" },
                ),
              ]
            : []),
          assistantMessage([text("Done")]),
        ],
      }).run("Find project code");
      const names = getCurrentTools(result.providerRequests[0]?.messages as Message[]).map(
        (tool) => tool.name,
      );
      expect(names.includes("semantic_search")).toBe(indexed);
      expect(getToolResultText(result, "script").includes("semantic_search")).toBe(indexed);
      if (indexed) {
        expect(getToolExecution(result, "semantic").isError).toBe(false);
        expect(getToolResultText(result, "semantic")).toContain("example.ts:1-2");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("the full IDE uses an existing index without rebuilding it", async () => {
  const root = path.resolve(".tmp/semantic-integration");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "full-"));
  try {
    const bin = path.join(cwd, "bin");
    await mkdir(bin);
    const executable = path.join(bin, "colgrep");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === '--version') console.log('colgrep 1.8.5');\nelse if (args[0] === 'status') console.log('Index: ' + process.cwd());\nelse if (args[0] === 'search') console.log(JSON.stringify([{unit:{file:'example.ts',line:1,end_line:99,name:'broad',code:'SOURCE_PAYLOAD'},matches:[{line:4,end_line:5,name:'first'},{line:7,end_line:8,name:'second'},{line:10,end_line:11,name:'third'},{line:13,end_line:14,name:'fourth'}]}]));\nelse process.exit(1);\n`,
    );
    await chmod(executable, 0o755);
    const result = await new PiIntegrationTest({
      testName: "semantic-full-ide",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["semantic_search"],
      environment: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      conversation: [
        assistantMessage(
          [toolCall({ id: "semantic", name: "semantic_search", arguments: { query: "example" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Find project code");
    expect(getToolExecution(result, "semantic").isError).toBe(false);
    const output = getToolResultText(result, "semantic");
    expect(output).toContain("example.ts:4-5  first");
    expect(output).toContain("example.ts:13-14  fourth");
    expect(output).not.toContain("SOURCE_PAYLOAD");
    expect(output).not.toContain("example.ts:1-99");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
