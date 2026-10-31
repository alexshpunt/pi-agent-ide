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
    `#!${process.execPath}\nconst fs=require('node:fs');\nconst path=require('node:path');\nconst args=process.argv.slice(2);\nfs.appendFileSync(process.env.TEST_LOG,JSON.stringify({args,cwd:process.cwd()})+'\\n');\nif(args[0]==='--version') console.log('colgrep 1.8.5');\nelse if(args[0]==='status') { if(fs.existsSync(path.join(process.cwd(),'.fake-index'))) console.log('Project: '+process.cwd()+'\\nIndex:   '+process.cwd()); else console.log('No index found'); }\nelse if(args[0]==='init') fs.writeFileSync(path.join(process.cwd(),'.fake-index'),'');\nelse if(args[0]==='search') console.log(JSON.stringify([{unit:{file:'src/example.ts',start_line:1,end_line:3}}]));\n`,
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
    expect((JSON.parse(result) as { unit: { file: string } }[])[0]?.unit.file).toBe(
      "src/example.ts",
    );
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

test("rejects remote project paths", async () => {
  await expect(indexProject("ssh://host/project")).rejects.toThrow(Error);
  await expect(searchProject("ssh://host/project", "query")).rejects.toThrow(Error);
});
