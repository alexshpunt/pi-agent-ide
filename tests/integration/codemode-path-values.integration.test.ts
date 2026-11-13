import { chmod, mkdir, writeFile } from "node:fs/promises";
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
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const fileSearchCode = `
function check(value, message) { if (!value) throw Error(message); }
const all = await tools.file_search({path:"logs",pattern:"*.log"});
check(Array.isArray(all) && all.length === 150 && all.every((file) => typeof file === "string"),
  "A script's file_search was capped: " + JSON.stringify(all).slice(0, 200));
check(all.includes("logs/entry-137.log"), "Paths are not relative to the session directory");
const limited = await tools.file_search({path:"logs",pattern:"*.log",limit:2});
check(Array.isArray(limited) && limited.length === 2, "An explicit limit was not honoured");
const none = await tools.file_search({path:"logs",pattern:"*.absent"});
check(Array.isArray(none) && none.length === 0, "No match is not an empty list");
check((await tools.file_search({path:"missing",pattern:"*"})) === null, "A failed file_search is not null");
const content = await tools.read({path: all.find((file) => file.endsWith("entry-137.log"))});
check(content.includes("PASS-137"), "The listed path did not read the file");
text("file_search paths verified");`;

test("file_search resolves to every matching path in Codemode and keeps the capped direct view", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await mkdir(path.join(cwd, "logs"));
    await Promise.all(
      Array.from({ length: 150 }, (_, index) =>
        writeFile(path.join(cwd, "logs", `entry-${String(index)}.log`), `PASS-${String(index)}\n`),
      ),
    );
    const run = await new PiIntegrationTest({
      testName: "codemode-file-search-paths",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      transport: "rpc",
      rawMode: false,
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["file_search", "read", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "direct",
              name: "file_search",
              arguments: { path: "logs", pattern: "*.log" },
              delayMs: 0,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "script",
              name: "codemode",
              arguments: { code: fileSearchCode },
              delayMs: 0,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("List the log files");
    for (const id of ["direct", "script"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    // A direct call keeps its readable list and the default cap of 100 files.
    const direct = getToolResultText(run, "direct");
    expect(direct.match(/logs\/entry-\d+\.log/gu)).toHaveLength(100);
    const script = getToolResultText(run, "script");
    expect(script).toContain("file_search paths verified");
    const failures = codemodeFailures(script);
    expect(failures).toMatch(/^1 of 5 IDE calls failed:\n/u);
    expect(failures).toContain("- file_search missing");
  });
});

test("a script's file_search returns a path list larger than 1 MiB", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    // 20,000 paths of about 70 bytes each: more than the 1 MiB limit of an agent's result.
    await mkdir(path.join(cwd, "big"));
    const prefix = "x".repeat(60);
    for (let start = 0; start < 20_000; start += 1000)
      await Promise.all(
        Array.from({ length: 1000 }, (_, offset) =>
          writeFile(path.join(cwd, "big", `${prefix}-${String(start + offset)}.txt`), ""),
        ),
      );
    const code = `
const all = await tools.file_search({path:"big",pattern:"*.txt"});
if (!Array.isArray(all) || all.length !== 20000) throw Error("Large list lost: " + JSON.stringify(all)?.slice(0, 200));
if (JSON.stringify(all).length <= 1024 * 1024) throw Error("The list did not exceed 1 MiB");
text("large file_search list verified");`;
    const run = await new PiIntegrationTest({
      testName: "codemode-file-search-large",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      transport: "rpc",
      rawMode: false,
      timeoutMs: 120000,
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["file_search", "codemode"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "script", name: "codemode", arguments: { code }, delayMs: 0 })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("List every text file");
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
    expect(getToolResultText(run, "script")).toContain("large file_search list verified");
  });
}, 180000);

test("semantic_search resolves to its ranked files in Codemode without ranges", async () => {
  await withTempWorkspace(async (cwd) => {
    const bin = path.join(cwd, "bin");
    await Promise.all([mkdir(bin), mkdir(path.join(cwd, "src"))]);
    await writeFile(path.join(cwd, "src/a.ts"), "export const a = 1;\n");
    await writeFile(path.join(cwd, "src/b.ts"), "export const b = 2;\n");
    const executable = path.join(bin, "colgrep");
    // ColGREP ranks b.ts above a.ts and reports b.ts twice; a scope after the query keeps its files.
    await writeFile(
      executable,
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst scope = args[args.indexOf('--') + 2];\nconst units = [{unit:{file:'src/b.ts',line:1,end_line:1,name:'b'}},{unit:{file:'src/a.ts',line:1,end_line:1,name:'a'}},{unit:{file:'src/b.ts',line:1,end_line:1,name:'b'}}];\nif (args[0] === '--version') console.log('colgrep 1.8.5');\nelse if (args[0] === 'status') console.log('Index: ' + process.cwd());\nelse if (args[0] === 'search') console.log(JSON.stringify(units.filter((u) => scope === undefined || u.unit.file === scope)));\nelse process.exit(1);\n`,
    );
    await chmod(executable, 0o755);
    const code = `
function check(value, message) { if (!value) throw Error(message); }
const ranked = await tools.semantic_search({query:"constant"});
check(JSON.stringify(ranked) === '["src/b.ts","src/a.ts"]', "Ranked files were lost: " + JSON.stringify(ranked));
const scoped = await tools.semantic_search({query:"constant",path:"src/b.ts"});
check(JSON.stringify(scoped) === '["src/b.ts"]', "A file scope returned ranges: " + JSON.stringify(scoped));
text("semantic_search files verified");`;
    const run = await new PiIntegrationTest({
      testName: "codemode-semantic-search-files",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      transport: "rpc",
      rawMode: false,
      environment: {
        PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent"),
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["semantic_search", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "direct",
              name: "semantic_search",
              arguments: { query: "constant", path: "src/b.ts" },
              delayMs: 0,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "script", name: "codemode", arguments: { code }, delayMs: 0 })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("Find the constants");
    for (const id of ["direct", "script"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    // A direct call keeps its approximate ranges as readable text.
    expect(getToolResultText(run, "direct")).toContain("src/b.ts:1-1");
    expect(getToolResultText(run, "script")).toContain("semantic_search files verified");
  });
});
