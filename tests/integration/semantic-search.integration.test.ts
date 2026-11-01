import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("disabling semantic search leaves ordinary text search available", async () => {
  const root = path.resolve(".tmp/semantic-integration");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "disabled-"));
  try {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["search.semantic"] }),
    );
    await writeFile(path.join(cwd, "example.txt"), "distinctive fixture value\n");
    const bin = path.join(cwd, "bin");
    await mkdir(bin);
    const colgrep = path.join(bin, "colgrep");
    await writeFile(
      colgrep,
      `#!${process.execPath}\nif(process.argv[2]==='--version')console.log('colgrep 1.8.5');else if(process.argv[2]==='status')console.log('Index: '+process.cwd());else process.exit(1);\n`,
    );
    await chmod(colgrep, 0o755);
    const result = await new PiIntegrationTest({
      testName: "semantic-disabled",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["semantic_search", "search"],
      environment: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "text-search",
              name: "search",
              arguments: { query: "distinctive fixture value", path: "example.txt" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Find the fixture");
    const names = getCurrentTools(result.providerRequests[0]?.messages as Message[]).map(
      (tool) => tool.name,
    );
    expect(names).not.toContain("semantic_search");
    expect(names).toContain("search");
    expect(getToolExecution(result, "text-search").isError).toBe(false);
    expect(getToolResultText(result, "text-search")).toContain("distinctive fixture value");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("the full IDE selects Vera from project settings and refreshes it before searching", async () => {
  const root = path.resolve(".tmp/semantic-integration");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "vera-"));
  try {
    const bin = path.join(cwd, "bin");
    const data = path.join(cwd, "data");
    const veraHome = path.join(data, "pi-agent-ide/vera");
    const model = path.join(
      veraHome,
      "models/minishlab/potion-code-16M-v2/revisions/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
    );
    await Promise.all([
      mkdir(bin),
      mkdir(model, { recursive: true }),
      mkdir(path.join(cwd, ".vera")),
      mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true }),
    ]);
    await Promise.all(
      ["config.json", "tokenizer.json", "model.safetensors"].map((name) =>
        writeFile(path.join(model, name), "ready"),
      ),
    );
    await writeFile(
      path.join(veraHome, "config.json"),
      JSON.stringify({ config_format: 2, local_mode: true, backend: "potion-code" }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ preferences: { "search.semantic.engine": "vera" } }),
    );
    const log = path.join(cwd, "calls.jsonl");
    const executable = path.join(bin, "vera");
    await writeFile(
      executable,
      `#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(process.env.TEST_LOG,JSON.stringify(a)+'\\n');if(a[0]==='--version')console.log('vera 2.3.0');else if(a[0]==='stats')console.log(JSON.stringify({file_count:1,chunk_count:1}));else if(a[0]==='update')console.log(JSON.stringify({files_deferred:0,parse_errors:[]}));else if(a[0]==='search')console.log(JSON.stringify([{file_path:'example.ts',line_start:4,line_end:5}]));else process.exit(1);\n`,
    );
    await chmod(executable, 0o755);
    const result = await new PiIntegrationTest({
      testName: "semantic-vera-selected",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["semantic_search"],
      environment: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        XDG_DATA_HOME: data,
        TEST_LOG: log,
      },
      conversation: [
        assistantMessage(
          [toolCall({ id: "semantic", name: "semantic_search", arguments: { query: "example" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Find project code");
    const callsText = await readFile(log, "utf8").catch(() => "no backend calls");
    expect(getToolExecution(result, "semantic").isError, callsText).toBe(false);
    expect(getToolResultText(result, "semantic")).toContain("example.ts");
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.findIndex((args) => args[0] === "update")).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((args) => args[0] === "update")).toBeLessThan(
      calls.findIndex((args) => args[0] === "search"),
    );
    expect(calls.some((args) => args[0] === "index" || args[0] === "setup")).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
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
    await writeFile(path.join(cwd, "example.ts"), "example source");
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
        assistantMessage(
          [
            toolCall({
              id: "scoped",
              name: "semantic_search",
              arguments: {
                query: "example",
                path: "example.ts",
                include: "*.ts",
                exclude: "*.test.ts",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Find project code");
    expect(getToolExecution(result, "semantic").isError).toBe(false);
    const output = getToolResultText(result, "semantic");
    expect(output.split("\n").filter((line) => line.includes("example.ts"))).toHaveLength(1);
    expect(output).toMatch(/\b4\b/u);
    expect(output).not.toContain("SOURCE_PAYLOAD");
    expect(getToolExecution(result, "scoped").isError).toBe(false);
    expect(getToolResultText(result, "scoped")).toContain("example.ts:4-5");
    expect(getToolResultText(result, "scoped")).toContain("example.ts:13-14");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
