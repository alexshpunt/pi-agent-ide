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
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.ts";

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
      await enableNativeCodemode(cwd);
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
        // rustup can prepend its toolchain bin to PATH when starting the server.
        // CARGO covers explicit executable lookup; RUSTC_WRAPPER is a second guard
        // against a toolchain proxy bypassing the Cargo interceptor.
        const rustcGuard = path.join(guard, "rustc-guard");
        await writeFile(
          rustcGuard,
          `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const [rustc, ...args] = process.argv.slice(2);
if (!args.includes("-vV") && !args.some(arg => arg.startsWith("--print"))) {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(["rustc", ...args]) + "\\n");
  process.exit(101);
}
process.exit(spawnSync(rustc, args, { stdio: "inherit" }).status ?? 1);
`,
        );
        await chmod(rustcGuard, 0o755);
        const result = await new PiIntegrationTest({
          testName: "rust-diagnostics-no-build",
          artifactsDir: testArtifactsDir(import.meta.filename),
          cwd,
          isolateUserResources: true,
          rawMode: false,
          timeoutMs: 120_000,
          environment: {
            PATH: `${guard}${path.delimiter}${process.env.PATH ?? ""}`,
            CARGO: cargo,
            RUSTC_WRAPPER: rustcGuard,
            CARGO_TARGET_DIR: path.join(guard, "cold-target"),
            CARGO_NET_OFFLINE: "true",
            RAYON_NUM_THREADS: "4",
          },
          extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
          tools: ["read", "codemode", "lsp_search"],
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
            assistantMessage(
              [
                toolCall({
                  id: "symbols",
                  name: "lsp_search",
                  arguments: { path: "src/main.rs", query: "main" },
                }),
              ],
              { stopReason: "toolUse" },
            ),
            assistantMessage([text("Done")]),
          ],
        }).run("Inspect Rust source and diagnostics without compiling the workspace.");
        for (const id of ["plain", "diagnostics", "symbols"])
          expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
        // Retain subprocess evidence even when the safety assertion fails.
        await writeFile(path.join(result.artifacts.directory, "cargo.jsonl"), await readFile(log));
        const calls = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
        // Toolchain proxies can bypass the Cargo wrapper for metadata. Prove that
        // the real server loaded the project through its symbol result instead.
        expect(getToolResultText(result, "symbols")).toContain("main");
        expect(
          calls.filter((args) =>
            args.some((arg) =>
              ["check", "clippy", "build", "test", "rustc", "doc", "run"].includes(arg),
            ),
          ),
        ).toEqual([]);
      } finally {
        await rm(guard, { recursive: true, force: true, maxRetries: 3 });
      }
    });
  },
  150_000,
);
