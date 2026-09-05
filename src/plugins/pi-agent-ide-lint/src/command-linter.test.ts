import path from "node:path";

import { describe, expect, it } from "vitest";

import { createCommandLinter } from "./command-linter.js";
import { LintCommandRegistry } from "./registry.js";

describe("command linter", () => {
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
