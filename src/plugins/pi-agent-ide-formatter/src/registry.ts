import path from "node:path";

import {
  hasConfiguredExecutable,
  loadLayeredToolConfig,
  matchesConfiguredFile,
  parseFormattersConfig,
} from "pi-agent-ide/api/tool-config";

import type {
  EffectiveToolConfigEntry,
  FormatterCommandConfig,
  FormattersConfig,
  LayeredToolConfigOptions,
} from "pi-agent-ide/api/tool-config";

/**
Validated formatter commands in project, global, and built-in priority order.
*/
export class FormatterCommandRegistry {
  private constructor(
    private readonly formatters: readonly EffectiveToolConfigEntry<FormatterCommandConfig>[],
    private readonly availableBuiltIns: ReadonlySet<string>,
  ) {}

  /**
  Loads and merges project, global, and built-in `formatters.json` files.
  */
  public static async fromDirectory(
    directory: string,
    options: LayeredToolConfigOptions = {},
  ): Promise<FormatterCommandRegistry> {
    const effective = await loadLayeredToolConfig(
      directory,
      "formatters",
      (value) => parseFormattersConfig(value).formatters,
      options,
    );
    const environment = options.environment ?? process.env;
    const available = await Promise.all(
      effective.entries
        .filter((entry) => entry.layer === "built-in")
        .map(async (entry) => ({
          id: entry.id,
          available: await hasConfiguredExecutable(entry.config.run, directory, environment),
        })),
    );
    return new FormatterCommandRegistry(
      effective.entries,
      new Set(available.filter((entry) => entry.available).map((entry) => entry.id)),
    );
  }

  /**
  Creates a project-layer registry from a validated value.
  */
  public static fromConfig(config: FormattersConfig): FormatterCommandRegistry {
    return new FormatterCommandRegistry(
      Object.entries(config.formatters).map(([id, formatter]) => ({
        id,
        config: formatter,
        layer: "project",
        sourcePath: "<memory>",
      })),
      new Set(),
    );
  }

  /**
  Returns the first command matching this file.
  */
  public resolve(filePath: string, projectRoot: string): FormatterCommandConfig | undefined {
    return this.resolveEntry(filePath, projectRoot)?.config;
  }

  /**
  Returns the first matching command together with its stable ID and source layer.
  */
  public resolveEntry(
    filePath: string,
    projectRoot: string,
  ): EffectiveToolConfigEntry<FormatterCommandConfig> | undefined {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
    return this.formatters.find(
      (formatter) =>
        (formatter.layer !== "built-in" || this.availableBuiltIns.has(formatter.id)) &&
        matchesConfiguredFile(formatter.config, absolute, projectRoot),
    );
  }

  /**
  Lists all merged entries in runtime resolution order.
  */
  public get entries(): readonly EffectiveToolConfigEntry<FormatterCommandConfig>[] {
    return this.formatters;
  }
}
