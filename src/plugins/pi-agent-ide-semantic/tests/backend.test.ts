import { afterEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inspectProject,
  indexProject,
  searchProject,
} from "#src/plugins/pi-agent-ide-semantic/src/backend.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function calls(log: string): Promise<{ args: string[]; cwd: string }[]> {
  return (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "semantic-test-"));
  temporary.push(root);
  const binary = join(root, "colgrep");
  const log = join(root, "calls.jsonl");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst fs=require('node:fs');\nconst path=require('node:path');\nconst args=process.argv.slice(2);\nfs.appendFileSync(process.env.TEST_LOG,JSON.stringify({args,cwd:process.cwd()})+'\\n');\nif(args[0]==='--version') console.log('colgrep 1.8.5');\nelse if(args[0]==='status') { if(fs.existsSync(path.join(process.cwd(),'.fake-index'))) console.log('Project: '+process.cwd()+'\\nIndex:   '+process.cwd()); else console.log('No index found'); }\nelse if(args[0]==='init') fs.writeFileSync(path.join(process.cwd(),'.fake-index'),'');\nelse if(args[0]==='search') console.log(process.env.TEST_OUTPUT ?? JSON.stringify([{unit:{file:'src/example.ts',line:1,end_line:3,name:'example'}}]));\n`,
  );
  await chmod(binary, 0o755);
  return { root, log, env: { ...process.env, PATH: root, TEST_LOG: log } };
}

test.skipIf(process.platform === "win32")(
  "indexing opts in only the selected project and subsequent search passes the query literally",
  async () => {
    const f = await fixture();
    const a = join(f.root, "a");
    const b = join(f.root, "b");
    await Promise.all([mkdir(a), mkdir(b)]);
    expect((await inspectProject(a, { env: f.env })).usable).toBe(false);
    await indexProject(a, { env: f.env });
    expect((await inspectProject(a, { env: f.env })).usable).toBe(true);
    expect((await inspectProject(b, { env: f.env })).usable).toBe(false);
    const result = await searchProject(a, "--strange query; echo unsafe", { env: f.env, limit: 3 });
    expect(result).toContain("src/example.ts");
    const history = await calls(f.log);
    const search = history.find((call) => call.args[0] === "search");
    expect(search?.cwd).toBe(a);
    expect(search?.args).toContain("--strange query; echo unsafe");
    expect(search?.args).toContain("--");
    expect(history.filter((call) => call.args[0] === "init")).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "search refuses to initialize a project without an index",
  async () => {
    const f = await fixture();
    await expect(searchProject(f.root, "find something", { env: f.env })).rejects.toThrow(Error);
    const history = await calls(f.log);
    expect(history.some((call) => call.args[0] === "search" || call.args[0] === "init")).toBe(
      false,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "search keeps every precise match without returning bulky metadata",
  async () => {
    const f = await fixture();
    await indexProject(f.root, { env: f.env });
    const output = [
      {
        unit: {
          file: join(f.root, "src/with spaces.ts"),
          line: 1,
          end_line: 999,
          name: "broad",
          code: "LARGE SOURCE",
        },
        matches: [
          { line: 5, end_line: 8, name: "first", score: 0.9 },
          { line: 10, end_line: 12, name: "second" },
          { line: 15, end_line: 16, name: "third" },
          { line: 20, end_line: 22, name: "fourth" },
        ],
      },
      { unit: { file: "fallback.ts", line: 30, end_line: 31, name: "fallback" } },
    ];
    const result = await searchProject(f.root, "query", {
      env: { ...f.env, TEST_OUTPUT: JSON.stringify(output) },
    });
    expect(result.split("\n")).toEqual([
      "src/with spaces.ts:5-8  first",
      "src/with spaces.ts:10-12  second",
      "src/with spaces.ts:15-16  third",
      "src/with spaces.ts:20-22  fourth",
      "fallback.ts:30-31  fallback",
    ]);
    expect(result).not.toContain("LARGE SOURCE");
  },
);

test.skipIf(process.platform === "win32")(
  "empty and malformed results remain distinct",
  async () => {
    const f = await fixture();
    await indexProject(f.root, { env: f.env });
    const search = (output: unknown) =>
      searchProject(f.root, "query", {
        env: { ...f.env, TEST_OUTPUT: JSON.stringify(output) },
      });
    expect(await search([])).toBeTruthy();
    await expect(search([{ unit: { file: "broken.ts" }, matches: [{ line: 0 }] }])).rejects.toThrow(
      Error,
    );
  },
);
test("rejects remote project paths", async () => {
  await expect(indexProject("ssh://host/project")).rejects.toThrow(Error);
  await expect(searchProject("ssh://host/project", "query")).rejects.toThrow(Error);
});
