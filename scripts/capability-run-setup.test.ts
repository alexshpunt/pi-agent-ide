import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { findRepositoryRoot } from "#scripts/repository-root.ts";
import { runProcess } from "#capabilities/sandbox.ts";
import { capabilityCases } from "#capabilities/cases.ts";

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
  prerequisite?: "timeout" | "failure",
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
    const auth = path.join(root, "auth");
    if (prerequisite) {
      await mkdir(auth);
      await writeFile(
        path.join(auth, "auth.json"),
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: "FIXTURE_ACCESS_TOKEN",
            refresh: "",
            expires: Date.now() + 3600000,
          },
        }),
      );
      const sandbox = pathToFileURL(
        path.join(repository, "benchmarks/tool-capabilities/sandbox.ts"),
      ).href;
      const child = `process.stdout.write(JSON.stringify({ ort: process.env.ORT_DYLIB_PATH, cpu: process.env.COLGREP_FORCE_CPU }) + "\\nSETUP_OUTPUT\\n"); process.stderr.write("SETUP_FAILURE FIXTURE_ACCESS_TOKEN\\n"); ${prerequisite === "timeout" ? 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);' : "process.exit(7);"} `;
      Object.assign(bindings, {
        "./sandbox.ts": dataModule(`export * from ${JSON.stringify(sandbox)};
          import { runProcess as actual } from ${JSON.stringify(sandbox)};
          export const runProcess = (command, args, options) => {
            if (command !== "bwrap" || args.at(-1) !== ${JSON.stringify(capabilityCases.find((task) => task.id === "semantic-code-search")?.prerequisite)})
              throw Error("Unexpected inference launch");
            return actual(process.execPath, ["-e", ${JSON.stringify(child)}], { ...options, env: { ...process.env, ...options.env }, timeoutMs: 1000 });
          };`),
      });
    }
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
            prerequisite ? "semantic-code-search" : "read-jq",
            "--mode",
            "direct",
            "--attempts",
            "1",
            ...(prerequisite ? ["--auth-dir", auth] : []),
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

test.each(["timeout", "failure"] as const)(
  "a prerequisite %s remains unavailable with retained evidence",
  async (kind) => {
    await fixture(async ({ source, results, invoke }) => {
      const execution = await invoke();
      expect(execution.timedOut).toBe(false);
      expect(execution.code).toBe(1);
      const attempts = JSON.parse(await readFile(path.join(results, "attempts.json"), "utf8")) as {
        status: string;
        evidence: string;
        reasons: string[];
      }[];
      expect(attempts).toHaveLength(1);
      const attempt = attempts[0];
      if (!attempt) throw new Error("Missing attempt");
      expect(attempt.status).toBe("unavailable");
      expect(attempt.reasons.join("\n")).toContain(
        capabilityCases.find((task) => task.id === "semantic-code-search")?.prerequisite,
      );
      expect(attempt.reasons.join("\n")).toContain("SETUP_FAILURE");
      expect(attempt.reasons.join("\n")).not.toContain("FIXTURE_ACCESS_TOKEN");
      const setup = JSON.parse(
        await readFile(path.join(results, attempt.evidence, "prerequisite.json"), "utf8"),
      ) as {
        code: number;
        timedOut: boolean;
        stdout: string;
        stderr: string;
        started: string;
        finished: string;
        timeoutMs: number;
      };
      expect(setup).toMatchObject({
        code: kind === "timeout" ? 0 : 7,
        timedOut: kind === "timeout",
        timeoutMs: 120000,
      });
      expect(setup.stdout).toContain("SETUP_OUTPUT");
      expect(setup.stderr).toContain("SETUP_FAILURE");
      expect(setup.stderr).not.toContain("FIXTURE_ACCESS_TOKEN");
      expect(Date.parse(setup.finished)).toBeGreaterThanOrEqual(Date.parse(setup.started));
      await noTrials(source);
    }, kind);
  },
  45000,
);
test("ColGREP initialization uses the private CPU runtime that searches will inherit", async () => {
  await fixture(async ({ results, invoke }) => {
    expect((await invoke()).code).toBe(1);
    const [attempt] = JSON.parse(await readFile(path.join(results, "attempts.json"), "utf8")) as {
      evidence: string;
      status: string;
    }[];
    if (!attempt) throw new Error("Missing attempt");
    expect(attempt.status).toBe("unavailable");
    const setup = JSON.parse(
      await readFile(path.join(results, attempt.evidence, "prerequisite.json"), "utf8"),
    ) as { stdout: string };
    expect(JSON.parse(setup.stdout.split("\n")[0] ?? "")).toEqual({
      ort: "/state/colgrep-runtime/lib/libonnxruntime.so",
      cpu: "1",
    });
  }, "failure");
}, 45000);
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
