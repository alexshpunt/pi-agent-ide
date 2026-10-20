import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { runProcess, sandboxArgs } from "#capabilities/sandbox.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/capability-identity-"));
  roots.push(root);
  const source = path.join(root, "source");
  const connector = path.join(root, "connector");
  for (const directory of [
    source,
    connector,
    path.join(root, "workspace/fixture"),
    path.join(root, "state"),
  ])
    await mkdir(directory, { recursive: true });
  await writeFile(path.join(source, "immutable.txt"), "UNCHANGED");
  await writeFile(path.join(root, "state/private.txt"), "PRIVATE_FIXTURE", { mode: 0o600 });
  await writeFile(path.join(root, "host-only.txt"), "HOST_SENTINEL", { mode: 0o600 });
  return { root, source, connector };
}

test("only explicit Claude CLI runs select a non-root namespace identity", async () => {
  const { root, source, connector } = await fixture();
  const args = await sandboxArgs(source, root, { root: connector, executable: "/usr/bin/true" });
  expect(args.slice(args.indexOf("--uid"), args.indexOf("--uid") + 4)).toEqual([
    "--uid",
    "1000",
    "--gid",
    "1000",
  ]);
  expect(await sandboxArgs(source, root)).not.toContain("--uid");
  expect(await sandboxArgs(source, root, { root: connector })).not.toContain("--uid");
});

test("non-root CLI children retain private state access and read-only source isolation", async () => {
  const { root, source, connector } = await fixture();
  const args = await sandboxArgs(source, root, { root: connector, executable: "/usr/bin/true" });
  const script = `
    const fs = require("node:fs");
    let sourceError;
    try { fs.writeFileSync("/source/immutable.txt", "MUTATED"); }
    catch (error) { sourceError = error.code; }
    fs.writeFileSync("/state/result.txt", "CASE_ONLY");
    console.log(JSON.stringify({ uid:process.getuid(), gid:process.getgid(),
      privateValue:fs.readFileSync("/state/private.txt","utf8"), sourceError,
      hostVisible:fs.existsSync(${JSON.stringify(path.join(root, "host-only.txt"))}) }));
  `;
  const run = await runProcess("bwrap", [...args, process.execPath, "-e", script], {
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 10_000,
  });
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({
    uid: 1000,
    gid: 1000,
    privateValue: "PRIVATE_FIXTURE",
    sourceError: "EROFS",
    hostVisible: false,
  });
  expect(await readFile(path.join(source, "immutable.txt"), "utf8")).toBe("UNCHANGED");
  expect(await readFile(path.join(root, "state/result.txt"), "utf8")).toBe("CASE_ONLY");
  expect(await readFile(path.join(root, "host-only.txt"), "utf8")).toBe("HOST_SENTINEL");
});
