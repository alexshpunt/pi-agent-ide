import { runConfiguredProcess } from "pi-agent-ide/api/tool-config";

import { parseDiagnostics } from "./diagnostics.js";
import { LintCommandRegistry } from "./registry.js";

import type { Linter } from "pi-agent-ide/api/toolchain";

/**
Creates a linter backed by validated project commands.
*/
export function createCommandLinter(registry: LintCommandRegistry): Linter {
  return {
    kind: "linter",
    name: "command-lint",
    priority: 100,
    extensions: ["*"],
    detect: () => Promise.resolve(true),
    async lint({ filePath, fix }, context) {
      const configured = registry.resolve(filePath, context.cwd);

      if (configured === undefined) {
        return { ok: true, diagnostics: [] };
      }

      const command =
        fix === true && configured.fix !== undefined ? configured.fix : configured.check;
      const result = await runConfiguredProcess(command, { projectRoot: context.cwd, filePath });
      const output = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
      return { ok: result.ok, diagnostics: parseDiagnostics(output, configured.diagnostics) };
    },
  };
}

/**
Creates the configured linter and reloads it when the project changes.
*/
export function createConfiguredCommandLinter(): Linter {
  let registryCwd: string | undefined;
  let registryReady: Promise<LintCommandRegistry> | undefined;
  const registryFor = (cwd: string): Promise<LintCommandRegistry> => {
    if (registryReady === undefined || registryCwd !== cwd) {
      registryCwd = cwd;
      registryReady = LintCommandRegistry.fromDirectory(cwd);
    }

    return registryReady;
  };
  return {
    kind: "linter",
    name: "command-lint",
    priority: 100,
    extensions: ["*"],
    detect: () => Promise.resolve(true),
    async lint(input, context) {
      return createCommandLinter(await registryFor(context.cwd)).lint(input, context);
    },
  };
}
