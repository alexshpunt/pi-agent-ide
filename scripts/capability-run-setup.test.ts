import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { findRepositoryRoot } from "#scripts/repository-root.ts";
import { runProcess } from "#capabilities/sandbox.ts";

const repository = findRepositoryRoot(import.meta.url);
const cli = path.join(repository, "benchmarks/tool-capabilities/cli.ts");
const inventory = pathToFileURL(
  path.join(repository, "benchmarks/tool-capabilities/inventory.ts"),
).href;
const dataModule = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;

async function fixture(
  run: (state: {
    source: string;
    results: string;
    invoke: () => ReturnType<typeof runProcess>;
    git: (...args: string[]) => void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-setup-"));
  try {
    const source = path.join(root, "repository");
    const results = path.join(root, "results");
    await mkdir(source);
    await writeFile(path.join(source, ".gitignore"), ".tmp/\n");
    await writeFile(path.join(source, "input.txt"), "SOURCE_FIXTURE\n");
    const git = (...args: string[]) => {
      execFileSync("git", args, { cwd: source, stdio: "pipe" });
    };
    git("init", "--quiet");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Initial",
    );
    // Bind filesystem setup to a small real Git repository, while inventory loads the real IDE.
    // The CLI, inventory, snapshotting, attempt and report implementations are not replaced.
    const bindings = {
      "#scripts/repository-root.ts": dataModule(
        `export const findRepositoryRoot = () => ${JSON.stringify(source)};`,
      ),
      "./inventory.ts":
        dataModule(`import { toolInventory as actual } from ${JSON.stringify(inventory)};
        export { piRuntime } from ${JSON.stringify(inventory)};
        export const toolInventory = (_, command) => actual(${JSON.stringify(repository)}, command);`),
    };
    const hook = path.join(root, "bindings.mjs");
    await writeFile(
      hook,
      `import { registerHooks } from 'node:module';
      const bindings = ${JSON.stringify(bindings)};
      registerHooks({ resolve(specifier, context, next) {
        if (context.parentURL === ${JSON.stringify(pathToFileURL(cli).href)} && bindings[specifier])
          return { url: bindings[specifier], shortCircuit: true };
        return next(specifier, context);
      }});`,
    );
    await run({
      source,
      results,
      git,
      // No --auth-dir: the first attempt stops before inference, retaining an unavailable result.
      invoke: () =>
        runProcess(
          process.execPath,
          [
            "--import",
            hook,
            cli,
            "--run",
            "--model",
            "luna-6-low",
            "--case",
            "read-jq",
            "--mode",
            "direct",
            "--attempts",
            "1",
            "--results",
            results,
          ],
          { cwd: repository, timeoutMs: 30000 },
        ),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function retainedAttempt(results: string) {
  const attempts: unknown = JSON.parse(await readFile(path.join(results, "attempts.json"), "utf8"));
  expect(attempts).toEqual([
    expect.objectContaining({ case: "read-jq", mode: "direct", status: "unavailable" }),
  ]);
  await access(path.join(results, "manifest.json"));
  await access(path.join(results, "matrix.md"));
}

async function noTrials(source: string) {
  expect(
    (await readdir(path.join(source, ".tmp"))).filter((name) => name.startsWith("capability-run-")),
  ).toEqual([]);
}

test("a fresh checkout with external results reaches an attempt and cleans temporary trials", async () => {
  await fixture(async ({ source, results, invoke }) => {
    const execution = await invoke();
    expect(execution.timedOut).toBe(false);
    expect(execution.code).toBe(1);
    await retainedAttempt(results);
    await noTrials(source);
  });
}, 45000);

test("temporary-directory setup failure leaves the results path reusable", async () => {
  await fixture(async ({ source, results, invoke }) => {
    const temporary = path.join(source, ".tmp");
    await writeFile(temporary, "BLOCKED\n");
    expect((await invoke()).code).toBe(1);
    await expect(access(results)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(temporary);
    expect((await invoke()).code).toBe(1);
    await retainedAttempt(results);
    await noTrials(source);
  });
}, 90000);

test("snapshot failure removes empty reports and trials before a retry", async () => {
  await fixture(async ({ source, results, invoke, git }) => {
    await mkdir(path.join(source, ".tmp"));
    git("config", "core.repositoryformatversion", "99");
    expect((await invoke()).code).toBe(1);
    await expect(access(results)).rejects.toMatchObject({ code: "ENOENT" });
    await noTrials(source);
    git("config", "--file", ".git/config", "core.repositoryformatversion", "0");
    expect((await invoke()).code).toBe(1);
    await retainedAttempt(results);
    await noTrials(source);
  });
}, 90000);

test("an existing results directory is never overwritten or removed", async () => {
  await fixture(async ({ results, invoke }) => {
    await mkdir(results);
    const sentinel = path.join(results, "sentinel");
    await writeFile(sentinel, "EXISTING\n");
    expect((await invoke()).code).toBe(1);
    expect(await readdir(results)).toEqual(["sentinel"]);
    expect(await readFile(sentinel, "utf8")).toBe("EXISTING\n");
  });
}, 45000);
