import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

function hasRustTools(): boolean {
  if (process.platform === "win32") return false;
  try {
    for (const command of ["rust-analyzer", "cargo"])
      execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test.runIf(hasRustTools())(
  "Rust diagnostic reads do not compile a cold Cargo workspace",
  async () => {
    await withTempWorkspace(async (temporary) => {
      // An optional real workspace exercises the same entry point without editing its source.
      const cwd = process.env.PI_RUST_DIAGNOSTICS_WORKSPACE ?? temporary;
      if (cwd === temporary) {
        await mkdir(path.join(cwd, "src"));
        await writeFile(
          path.join(cwd, "Cargo.toml"),
          '[package]\nname = "diagnostic-read"\nversion = "0.1.0"\nedition = "2021"\n',
        );
        await writeFile(path.join(cwd, "src/main.rs"), "fn main() { let value = ; }\n");
        await writeFile(
          path.join(cwd, "build.rs"),
          'fn main() { panic!("diagnostic reads must not execute build scripts"); }\n',
        );
      }
      const guard = await mkdtemp(path.join(os.tmpdir(), "rust-diagnostics-guard-"));
      try {
        const realCargo = execFileSync("sh", ["-c", "command -v cargo"], {
          encoding: "utf8",
        }).trim();
        const log = path.join(guard, "cargo.jsonl");
        const cargo = path.join(guard, "cargo");
        await writeFile(log, "");
        await writeFile(
          cargo,
          `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
// Observe the attempted build, but never compile the user's dependency tree.
if (args.some(arg => ["check", "clippy", "build", "test", "rustc", "doc", "run"].includes(arg))) process.exit(101);
const result = spawnSync(${JSON.stringify(realCargo)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        );
        await chmod(cargo, 0o755);
        const result = await new PiIntegrationTest({
          testName: "rust-diagnostics-no-build",
          artifactsDir: testArtifactsDir(import.meta.filename),
          cwd,
          isolateUserResources: true,
          rawMode: false,
          timeoutMs: 120_000,
          environment: {
            PATH: `${guard}${path.delimiter}${process.env.PATH ?? ""}`,
            CARGO_TARGET_DIR: path.join(guard, "cold-target"),
            CARGO_NET_OFFLINE: "true",
            RAYON_NUM_THREADS: "4",
          },
          extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
          tools: ["read", "codemode"],
          conversation: [
            assistantMessage(
              [toolCall({ id: "plain", name: "read", arguments: { path: "src/main.rs" } })],
              { stopReason: "toolUse" },
            ),
            assistantMessage(
              [
                toolCall({
                  id: "diagnostics",
                  name: "codemode",
                  arguments: {
                    code: 'await tools.read({path:"src/main.rs",views:["diagnostics"]}); await tools.read({path:"diagnostics:src/main.rs"});',
                  },
                }),
              ],
              { stopReason: "toolUse" },
            ),
            assistantMessage([text("Done")]),
          ],
        }).run("Inspect Rust source and diagnostics without compiling the workspace.");
        for (const id of ["plain", "diagnostics"])
          expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
        // Retain subprocess evidence even when the safety assertion fails.
        await writeFile(path.join(result.artifacts.directory, "cargo.jsonl"), await readFile(log));
        const calls = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
        expect(
          calls.some((args) => args.includes("metadata")),
          JSON.stringify(calls),
        ).toBe(true);
        expect(
          calls.filter((args) =>
            args.some((arg) =>
              ["check", "clippy", "build", "test", "rustc", "doc", "run"].includes(arg),
            ),
          ),
        ).toEqual([]);
      } finally {
        await rm(guard, { recursive: true, force: true });
      }
    });
  },
  150_000,
);
