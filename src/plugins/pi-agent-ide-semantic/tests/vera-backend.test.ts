import { afterEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  indexVeraProject,
  inspectVeraProject,
  searchVeraProject,
} from "#src/plugins/pi-agent-ide-semantic/src/vera-backend.js";

const roots: string[] = []; // Each fixture owns an isolated project.
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vera-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  const project = join(root, "project");
  const data = join(root, "data");
  await Promise.all([mkdir(bin), mkdir(project), mkdir(data)]);
  const log = join(root, "calls");
  await writeFile(
    join(bin, "vera"),
    `#!${process.execPath}\nconst fs=require('node:fs');const p=require('node:path');const a=process.argv.slice(2);fs.appendFileSync(process.env.TEST_LOG,JSON.stringify({args:a,cwd:process.cwd(),backend:process.env.VERA_BACKEND,api:process.env.RERANKER_MODEL_BASE_URL})+'\\n');if(a[0]==='--version')console.log('vera 2.3.0');else if(a[0]==='setup'){const d=p.join(process.env.VERA_HOME,'models/minishlab/potion-code-16M-v2/revisions/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b');fs.mkdirSync(d,{recursive:true});for(const x of ['config.json','model.safetensors','tokenizer.json'])fs.writeFileSync(p.join(d,x),'ready');fs.writeFileSync(p.join(process.env.VERA_HOME,'config.json'),JSON.stringify({config_format:2,local_mode:true,backend:'potion-code'}));}else if(a[0]==='stats'){if(!fs.existsSync('.vera'))process.exit(1);console.log(JSON.stringify({file_count:1,chunk_count:1}));}else if(a[0]==='index'){fs.mkdirSync('.vera',{recursive:true});console.log('{}');}else if(a[0]==='update'){if(process.env.FAIL_UPDATE)process.exit(2);console.log(JSON.stringify({files_deferred:process.env.FAIL_DEFER?1:0,embedding_failed_batches:0,parse_errors:process.env.FAIL_PARSE?['bad.ts']:[]}));}else if(a[0]==='search')console.log(process.env.TEST_OUTPUT??'[]');else process.exit(4);\n`,
  );
  await chmod(join(bin, "vera"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    XDG_DATA_HOME: data,
    HOME: root,
    TEST_LOG: log,
    RERANKER_MODEL_BASE_URL: "https://forbidden.invalid",
  };
  const history = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { args: string[]; cwd: string; backend?: string; api?: string },
      );
  return { root, project, env, history, veraHome: join(data, "pi-agent-ide", "vera") };
}

test.skipIf(process.platform === "win32")(
  "indexes explicitly and updates before searching without hosted providers",
  async () => {
    const f = await fixture();
    expect((await inspectVeraProject(f.project, { env: f.env })).usable).toBe(false);
    await indexVeraProject(f.project, { env: f.env });
    expect((await inspectVeraProject(f.project, { env: f.env })).usable).toBe(true);
    await searchVeraProject(f.project, "find it", { env: f.env });
    const history = await f.history();
    expect(history.findIndex((x) => x.args[0] === "update")).toBeLessThan(
      history.findIndex((x) => x.args[0] === "search"),
    );
    for (const call of history.filter((x) =>
      ["setup", "index", "update", "search"].includes(x.args[0] ?? ""),
    )) {
      expect(call.backend).toBe("potion-code-cpu");
      expect(call.api).toBeUndefined();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "search never initializes a missing index or local model",
  async () => {
    const f = await fixture();
    await expect(searchVeraProject(f.project, "find it", { env: f.env })).rejects.toThrow(Error);
    expect(
      (await f.history()).some((x) =>
        ["setup", "index", "update", "search"].includes(x.args[0] ?? ""),
      ),
    ).toBe(false);
  },
);
test.skipIf(process.platform === "win32")("does not search when index refresh fails", async () => {
  const f = await fixture();
  await indexVeraProject(f.project, { env: f.env });
  await expect(
    searchVeraProject(f.project, "find it", { env: { ...f.env, FAIL_UPDATE: "1" } }),
  ).rejects.toThrow(Error);
  expect((await f.history()).some((x) => x.args[0] === "search")).toBe(false);
  await expect(
    searchVeraProject(f.project, "find it", { env: { ...f.env, FAIL_DEFER: "1" } }),
  ).rejects.toThrow(Error);
  await expect(
    searchVeraProject(f.project, "find it", { env: { ...f.env, FAIL_PARSE: "1" } }),
  ).rejects.toThrow(Error);
  expect((await f.history()).some((x) => x.args[0] === "search")).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "scopes grouped results and excludes paths before returning them",
  async () => {
    const f = await fixture();
    await indexVeraProject(f.project, { env: f.env });
    await mkdir(join(f.project, "src with spaces"));
    await writeFile(join(f.project, "src with spaces/a.ts"), "a");
    await writeFile(join(f.project, "src with spaces/a.test.ts"), "b");
    const output = [
      { file_path: "src with spaces/a.ts", line_start: 1, line_end: 3 },
      { file_path: "src with spaces/a.ts", line_start: 1, line_end: 3 },
      { file_path: "src with spaces/a.ts", line_start: 5, line_end: 6 },
      { file_path: "src with spaces/a.test.ts", line_start: 1, line_end: 1 },
    ];
    const result = await searchVeraProject(f.project, "query", {
      env: { ...f.env, TEST_OUTPUT: JSON.stringify(output) },
      path: "src with spaces",
      include: "*.ts",
      exclude: "*.test.ts",
    });
    expect(result.split("\n").filter((x) => x.includes("src with spaces/a.ts"))).toHaveLength(1);
    expect(result).toMatch(/\b2\b/u);
    expect(result).not.toContain("a.test.ts");
    const args = (await f.history()).find((x) => x.args[0] === "search")?.args;
    expect(args).toContain("--path");
    const file = await searchVeraProject(f.project, "query", {
      env: { ...f.env, TEST_OUTPUT: JSON.stringify(output) },
      path: "src with spaces/a.ts",
    });
    expect(file).toContain("src with spaces/a.ts:1-3");
    expect(file).not.toContain("a.test.ts");
  },
);

test.skipIf(process.platform === "win32")(
  "does not reuse another project's index through a symlink",
  async () => {
    const f = await fixture();
    await indexVeraProject(f.project, { env: f.env });
    const other = join(f.root, "linked-project");
    await mkdir(other);
    await symlink(join(f.project, ".vera"), join(other, ".vera"));
    expect((await inspectVeraProject(other, { env: f.env })).usable).toBe(false);
    await expect(searchVeraProject(other, "query", { env: f.env })).rejects.toThrow(Error);
  },
);
test.skipIf(process.platform === "win32")(
  "refuses missing, remote and symlink-escaped scopes",
  async () => {
    const f = await fixture();
    await indexVeraProject(f.project, { env: f.env });
    await symlink(dirname(f.project), join(f.project, "escape"));
    for (const path of ["missing.ts", "ssh://host/file", "escape"])
      await expect(searchVeraProject(f.project, "query", { env: f.env, path })).rejects.toThrow(
        Error,
      );
  },
);

test.skipIf(process.platform === "win32")(
  "file search indicates omitted approximate ranges",
  async () => {
    const f = await fixture();
    await indexVeraProject(f.project, { env: f.env });
    await writeFile(join(f.project, "ranges.ts"), "content");
    const output = Array.from({ length: 20 }, (_, i) => ({
      file_path: "ranges.ts",
      line_start: i + 1,
      line_end: i + 1,
    }));
    const result = await searchVeraProject(f.project, "query", {
      env: { ...f.env, TEST_OUTPUT: JSON.stringify(output) },
      path: "ranges.ts",
    });
    expect(result).toContain("ranges.ts:15-15");
    expect(result).not.toContain("ranges.ts:20-20");
    expect(result).toMatch(/\b5\b/u);
    const args = (await f.history()).find((x) => x.args[0] === "search")?.args;
    expect(args?.[args.indexOf("--limit") + 1]).toBe("100");
  },
);

test.skipIf(process.platform === "win32")(
  "rejects a managed Vera configuration that could send source to a reranker",
  async () => {
    const f = await fixture();
    await indexVeraProject(f.project, { env: f.env });
    await writeFile(
      join(f.veraHome, "config.json"),
      JSON.stringify({
        config_format: 2,
        local_mode: true,
        backend: "potion-code",
        retrieval: { reranking_enabled: true },
      }),
    );
    expect((await inspectVeraProject(f.project, { env: f.env })).usable).toBe(false);
    await expect(searchVeraProject(f.project, "find it", { env: f.env })).rejects.toThrow(Error);
    expect((await f.history()).some((x) => x.args[0] === "search" || x.args[0] === "update")).toBe(
      false,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "groups unique candidate ranges and keeps project indexes separate",
  async () => {
    const f = await fixture();
    await indexVeraProject(f.project, { env: f.env });
    const other = join(f.root, "other");
    await mkdir(other);
    expect((await inspectVeraProject(other, { env: f.env })).usable).toBe(false);
    const output = [
      { file_path: "src/a.ts", line_start: 2, line_end: 4 },
      { file_path: "src/b.ts", line_start: 8, line_end: 9 },
      { file_path: "src/a.ts", line_start: 2, line_end: 4 },
      { file_path: "src/a.ts", line_start: 10, line_end: 12 },
    ];
    const result = await searchVeraProject(f.project, "query", {
      env: { ...f.env, TEST_OUTPUT: JSON.stringify(output) },
    });
    const lines = result.split("\n");
    expect(lines.filter((line) => line.includes("src/a.ts"))).toHaveLength(1);
    expect(lines[0]).toContain("src/a.ts");
    expect(lines[0]).toMatch(/\b2\b/u);
    expect(lines[1]).toContain("src/b.ts");
    await expect(
      searchVeraProject(f.project, "query", {
        env: {
          ...f.env,
          TEST_OUTPUT: JSON.stringify([{ file_path: "broken.ts", line_start: 0, line_end: 1 }]),
        },
      }),
    ).rejects.toThrow(Error);
  },
);
