import path from "node:path";

import { describe, expect, it } from "vitest";

import { requiredValue } from "pi-agent-invariant";

import { LINTER_RECIPES } from "./catalog.ts";
import { createCommandLinter, runConfiguredLinter } from "./command-linter.ts";
import { LintCommandRegistry } from "./registry.ts";

describe("command linter", () => {
  it("keeps project-wide findings attached to their own file", async () => {
    const registry = LintCommandRegistry.fromConfig({
      version: 1,
      linters: {
        project: {
          extensions: [".go"],
          check: {
            command: [
              process.execPath,
              "-e",
              "console.log('other.go:9:2: warning: other [X]\\nmain.go:3:1: warning: current [Y]'); process.exitCode = 1",
            ],
            successExitCodes: [0, 1],
          },
          diagnostics: { format: "gcc" },
        },
      },
    });
    const cwd = process.cwd();
    const result = await createCommandLinter(registry).lint(
      { filePath: path.join(cwd, "main.go") },
      { cwd },
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toMatchObject([{ code: "Y", line: 3 }]);
  });

  it("does not report a missing toolchain component as a clean lint run", async () => {
    const registry = LintCommandRegistry.fromConfig({
      version: 1,
      linters: {
        clippy: {
          extensions: [".rs"],
          check: {
            command: [
              process.execPath,
              "-e",
              "process.stderr.write('error: cargo-clippy is not installed'); process.exitCode = 1",
            ],
            successExitCodes: [0, 1],
          },
          diagnostics: { format: "gcc" },
        },
      },
    });
    const cwd = process.cwd();
    await expect(
      createCommandLinter(registry).lint({ filePath: path.join(cwd, "main.rs") }, { cwd }),
    ).resolves.toEqual({ ok: false, diagnostics: [] });
  });
  it("reports Clippy findings when Cargo exits with 101 for a compile error", async () => {
    const clippy = requiredValue(LINTER_RECIPES.find((recipe) => recipe.id === "clippy")?.linter);
    const output = [
      "Blocking waiting for file lock on build directory",
      "    Checking app v0.1.0 (/work/app)",
      "main.rs:4:9: error[E0308]: mismatched types",
      "error: could not compile `app` (lib) due to 1 previous error",
    ].join("\n");
    const registry = LintCommandRegistry.fromConfig({
      version: 1,
      linters: {
        clippy: {
          extensions: [".rs"],
          diagnostics: { format: "gcc" },
          check: {
            ...(clippy.check.successExitCodes && {
              successExitCodes: clippy.check.successExitCodes,
            }),
            command: [
              process.execPath,
              "-e",
              `process.stderr.write(${JSON.stringify(output)}); process.exitCode = 101`,
            ],
          },
        },
      },
    });
    const cwd = process.cwd();
    await expect(
      createCommandLinter(registry).lint({ filePath: path.join(cwd, "main.rs") }, { cwd }),
    ).resolves.toEqual({
      ok: true,
      diagnostics: [
        { code: "E0308", message: "mismatched types", line: 4, column: 9, severity: "error" },
      ],
    });
  });

  it("names what a timed-out command waited for", async () => {
    const result = await runConfiguredLinter(
      {
        extensions: [".rs"],
        check: {
          command: [
            process.execPath,
            "-e",
            "process.stderr.write('    Checking app\\nBlocking waiting for file lock on build directory\\n'); setTimeout(() => {}, 10000)",
          ],
          timeoutMs: 1000,
        },
        diagnostics: { format: "gcc" },
      },
      { projectRoot: process.cwd(), filePath: path.join(process.cwd(), "main.rs") },
    );
    expect(result).toMatchObject({
      ok: false,
      failure:
        "timed out after 1 s; last output: Blocking waiting for file lock on build directory",
    });
  });

  it("returns a failed lint result when a command does not emit its configured format", async () => {
    const registry = LintCommandRegistry.fromConfig({
      version: 1,
      linters: {
        oxlint: {
          extensions: [".ts"],
          check: {
            command: [
              process.execPath,
              "-e",
              "process.stdout.write('This oxlint output is not SARIF'); process.exitCode = 1",
            ],
            successExitCodes: [0, 1],
          },
          diagnostics: { format: "sarif" },
        },
      },
    });
    const cwd = process.cwd();

    await expect(
      createCommandLinter(registry).lint(
        { filePath: path.join(cwd, "source.ts"), fix: false },
        { cwd },
      ),
    ).resolves.toEqual({ ok: false, diagnostics: [] });
  });

  it("returns a failed lint result when a configured command cannot start", async () => {
    const registry = LintCommandRegistry.fromConfig({
      version: 1,
      linters: {
        missing: {
          extensions: [".ts"],
          check: { command: ["pi-agent-ide-missing-linter", "{file}"] },
          diagnostics: { format: "gcc" },
        },
      },
    });
    const cwd = process.cwd();

    await expect(
      createCommandLinter(registry).lint(
        { filePath: path.join(cwd, "source.ts"), fix: false },
        { cwd },
      ),
    ).resolves.toEqual({ ok: false, diagnostics: [] });
  });
});
