import { runConfiguredProcess } from "pi-agent-ide/api/tool-config";

import { parseDiagnostics } from "./diagnostics.js";
import { LintCommandRegistry } from "./registry.js";

import type { LinterCommandConfig, ProcessResult } from "pi-agent-ide/api/tool-config";
import type { Diagnostic, Linter, LintResult } from "pi-agent-ide/api/toolchain";

/** A lint result with a short failure reason for doctor reports. */
export interface ConfiguredLintResult extends LintResult {
  readonly failure?: string;
}

/**
 * Runs one configured linter and turns launch or parser errors into a normal failed result.
 */
export async function runConfiguredLinter(
  config: LinterCommandConfig,
  context: {
    readonly projectRoot: string;
    readonly filePath: string;
    readonly env?: NodeJS.ProcessEnv;

    readonly signal?: AbortSignal;
  },
): Promise<ConfiguredLintResult> {
  let result: ProcessResult;

  try {
    result = await runConfiguredProcess(config.check, context);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [],
      failure: `command could not start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const output = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
  let diagnostics: Diagnostic[];

  try {
    diagnostics = parseDiagnostics(output, config.diagnostics);
  } catch {
    return {
      ok: false,
      diagnostics: [],
      failure: `invalid ${config.diagnostics.format} diagnostics: ${output.trim().slice(0, 200) || "empty command output"}`,
    };
  }

  return {
    ok: result.ok,
    diagnostics,
    ...(!result.ok && {
      failure:
        result.stderr.trim().slice(0, 200) || `command exited with code ${String(result.exitCode)}`,
    }),
  };
}

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
      const result = await runConfiguredLinter(
        { ...configured, check: command },
        { projectRoot: context.cwd, filePath },
      );
      return { ok: result.ok, diagnostics: result.diagnostics };
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
