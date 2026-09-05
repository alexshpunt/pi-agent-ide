import path from "node:path";

import {
  hasConfiguredExecutable,
  loadLayeredToolConfig,
  matchesConfiguredFile,
  parseLintersConfig,
} from "pi-agent-ide/api/tool-config";

import type {
  EffectiveToolConfigEntry,
  LinterCommandConfig,
  LintersConfig,
  LayeredToolConfigOptions,
} from "pi-agent-ide/api/tool-config";

/**
Validated linter commands in project, global, and built-in priority order.
*/
export class LintCommandRegistry {
  private constructor(
    private readonly linters: readonly EffectiveToolConfigEntry<LinterCommandConfig>[],
    private readonly availableBuiltIns: ReadonlySet<string>,
  ) {}

  /**
  Loads and merges project, global, and built-in `linters.json` files.
  */
  public static async fromDirectory(
    directory: string,
    options: LayeredToolConfigOptions = {},
  ): Promise<LintCommandRegistry> {
    const effective = await loadLayeredToolConfig(
      directory,
      "linters",
      (value) => parseLintersConfig(value).linters,
      options,
    );
    const environment = options.environment ?? process.env;
    const available = await Promise.all(
      effective.entries
        .filter((entry) => entry.layer === "built-in")
        .map(async (entry) => ({
          id: entry.id,
          available: await hasConfiguredExecutable(entry.config.check, directory, environment),
        })),
    );
    return new LintCommandRegistry(
      effective.entries,
      new Set(available.filter((entry) => entry.available).map((entry) => entry.id)),
    );
  }

  /**
  Creates a project-layer registry from a validated config.
  */
  public static fromConfig(config: LintersConfig): LintCommandRegistry {
    return new LintCommandRegistry(
      Object.entries(config.linters).map(([id, linter]) => ({
        id,
        config: linter,
        layer: "project",
        sourcePath: "<memory>",
      })),
      new Set(),
    );
  }

  /**
  Returns the first command matching this file.
  */
  public resolve(filePath: string, projectRoot: string): LinterCommandConfig | undefined {
    return this.resolveEntry(filePath, projectRoot)?.config;
  }

  /**
  Returns the first matching command together with its stable ID and source layer.
  */
  public resolveEntry(
    filePath: string,
    projectRoot: string,
  ): EffectiveToolConfigEntry<LinterCommandConfig> | undefined {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
    return this.linters.find(
      (linter) =>
        (linter.layer !== "built-in" || this.availableBuiltIns.has(linter.id)) &&
        matchesConfiguredFile(linter.config, absolute, projectRoot),
    );
  }

  /**
  Lists all merged entries in runtime resolution order.
  */
  public get entries(): readonly EffectiveToolConfigEntry<LinterCommandConfig>[] {
    return this.linters;
  }
}
