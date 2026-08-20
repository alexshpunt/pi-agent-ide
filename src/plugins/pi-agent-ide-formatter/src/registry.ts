import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  matchesConfiguredFile,
  parseFormattersConfig,
  projectIdeConfigPath,
} from "pi-agent-ide/api/tool-config";

import type { FormatterCommandConfig, FormattersConfig } from "pi-agent-ide/api/tool-config";

/**
Validated formatter commands for one project.
*/
export class FormatterCommandRegistry {
  private constructor(private readonly formatters: readonly FormatterCommandConfig[]) {}

  /**
    Loads `.pi/pi-agent-ide/formatters.json`.
    */
  public static async fromDirectory(directory: string): Promise<FormatterCommandRegistry> {
    try {
      const raw = await readFile(projectIdeConfigPath(directory, "formatters"), "utf8");
      return FormatterCommandRegistry.fromConfig(parseFormattersConfig(JSON.parse(raw)));
    } catch (error) {
      if (isMissingFile(error)) {
        return FormatterCommandRegistry.fromConfig({ version: 1, formatters: {} });
      }

      throw error;
    }
  }

  /**
    Creates a registry from a validated value.
    */
  public static fromConfig(config: FormattersConfig): FormatterCommandRegistry {
    return new FormatterCommandRegistry(Object.values(config.formatters));
  }

  /**
    Returns the first command matching this file.
    */
  public resolve(filePath: string, projectRoot: string): FormatterCommandConfig | undefined {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
    return this.formatters.find((formatter) =>
      matchesConfiguredFile(formatter, absolute, projectRoot),
    );
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
