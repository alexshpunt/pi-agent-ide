import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  matchesConfiguredFile,
  parseLintersConfig,
  projectIdeConfigPath,
} from "pi-agent-ide/api/tool-config";

import type { LinterCommandConfig, LintersConfig } from "pi-agent-ide/api/tool-config";

/**
Validated linter commands for one project.
*/
export class LintCommandRegistry {
  private constructor(private readonly linters: readonly LinterCommandConfig[]) {}

  /**
    Loads `.pi/pi-agent-ide/linters.json`.
    */
  public static async fromDirectory(directory: string): Promise<LintCommandRegistry> {
    try {
      const raw = await readFile(projectIdeConfigPath(directory, "linters"), "utf8");
      return LintCommandRegistry.fromConfig(parseLintersConfig(JSON.parse(raw)));
    } catch (error) {
      if (isMissingFile(error)) {
        return LintCommandRegistry.fromConfig({ version: 1, linters: {} });
      }

      throw error;
    }
  }

  /**
    Creates a registry from a validated config.
    */
  public static fromConfig(config: LintersConfig): LintCommandRegistry {
    return new LintCommandRegistry(Object.values(config.linters));
  }

  /**
    Returns the first command matching this file.
    */
  public resolve(filePath: string, projectRoot: string): LinterCommandConfig | undefined {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
    return this.linters.find((linter) => matchesConfiguredFile(linter, absolute, projectRoot));
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
