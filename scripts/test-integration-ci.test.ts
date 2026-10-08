import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

const run = promisify(execFile);
const namespaceFiles = [
  "tests/integration/ssh-process-namespaces.integration.test.ts",
  "tests/integration/ssh-process-namespaces-tools.integration.test.ts",
  "tests/integration/ssh-file-identities.integration.test.ts",
  "tests/integration/ssh-web-network.integration.test.ts",
  "tests/integration/ssh-web-network-tools.integration.test.ts",
];

test.each([
  { group: "2/4", exit: 0, report: "2" },
  { group: "namespaces", exit: 0, report: "namespaces" },
  { group: "1/4", exit: 7, report: "1" },
])("runs only its CI group and retains the real exit status: $group / $exit", async (fixture) => {
  const root = findRepositoryRoot(import.meta.url);
  const parent = path.join(root, ".tmp/ci-shard-contract-tests");
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(path.join(parent, "workspace-"));
  try {
    await mkdir(path.join(cwd, "scripts"));
    await mkdir(path.join(cwd, "node_modules/.bin"), { recursive: true });
    await writeFile(path.join(cwd, "node_modules/.bin/pi"), "#!/bin/sh\nprintf 'fixture-pi'\n", {
      mode: 0o755,
    });
    await mkdir(path.join(cwd, "node_modules/vitest"), { recursive: true });
    await copyFile(
      path.join(root, "scripts/test-integration-ci.sh"),
      path.join(cwd, "scripts/run.sh"),
    );
    await writeFile(
      path.join(cwd, "node_modules/vitest/vitest.mjs"),
      `#!${process.execPath}\nimport { execFileSync } from 'node:child_process';\nconsole.log(JSON.stringify({arguments:process.argv.slice(2),runner:process.env.PI_INTEGRATION_TEST_RUNNER ?? null,pi:execFileSync('pi', [], {encoding:'utf8'})})); process.exit(${fixture.exit});\n`,
      { mode: 0o755 },
    );
    let exit = 0;
    try {
      await run("bash", ["scripts/run.sh", fixture.group], {
        cwd,
        env: {
          ...process.env,
          PI_INTEGRATION_TEST_RUNNER: "shared",
        },
      });
    } catch (error) {
      if (error === null || typeof error !== "object" || !("code" in error)) throw error;
      exit = Number(error.code);
    }
    expect(exit).toBe(fixture.exit);
    const captured = JSON.parse(
      await readFile(path.join(cwd, `.tmp/integration-ci/${fixture.report}.log`), "utf8"),
    ) as {
      arguments: string[];
      runner: string | null;
      pi: string;
    };
    expect(captured.runner).toBeNull();
    expect(captured.pi).toBe("fixture-pi");
    expect(captured.arguments).toContain(
      `--outputFile.junit=.agents/tmp/test-results/integration-${fixture.report}.xml`,
    );
    expect(captured.arguments).toContain("--reporter=junit");
    if (fixture.group === "namespaces") {
      expect(captured.arguments.filter((value) => value.endsWith(".test.ts"))).toEqual(
        namespaceFiles,
      );
      expect(captured.arguments).not.toContain("--exclude");
      expect(captured.arguments.some((value) => value.startsWith("--shard="))).toBe(false);
    } else {
      expect(captured.arguments).toContain(`--shard=${fixture.group}`);
      expect(
        captured.arguments.filter((value, index, values) => values[index - 1] === "--exclude"),
      ).toEqual([...namespaceFiles, "tests/integration/debugger*.integration.test.ts"]);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
