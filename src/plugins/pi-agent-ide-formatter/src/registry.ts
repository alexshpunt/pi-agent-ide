import { FORMATTER_RECIPES } from "./catalog.js";
import {
  toolRuntimeEvidence,
  loadLayeredToolConfig,
  selectConfiguredEntry,
  parseFormattersConfig,
} from "pi-agent-ide/api/tool-config";
import type {
  EffectiveToolConfigEntry,
  FormatterCommandConfig,
  FormattersConfig,
  ToolRuntimeConfigOptions,
} from "pi-agent-ide/api/tool-config";
/**
Validated formatter commands in project, global, and built-in priority order.
*/
export class FormatterCommandRegistry {
  private constructor(
    private readonly formatters: readonly EffectiveToolConfigEntry<FormatterCommandConfig>[],
    private readonly availableBuiltIns: ReadonlySet<string>,

    private readonly evidence: ReadonlyMap<string, { readonly score: number }> = new Map(),
  ) {}

  /**
  Loads and merges project, global, and built-in `formatters.json` files.
  */
  public static async fromDirectory(
    directory: string,
    options: ToolRuntimeConfigOptions = {},
  ): Promise<FormatterCommandRegistry> {
    const effective = await loadLayeredToolConfig(
      directory,
      "formatters",
      (value) => parseFormattersConfig(value).formatters,
      options,
    );
    const { available, evidence } = await toolRuntimeEvidence(
      directory,
      effective.entries
        .filter((entry) => entry.layer === "built-in")
        .map((entry) => ({ id: entry.id, config: entry.config.run })),
      FORMATTER_RECIPES,
      options,
    );
    const entries = [...effective.entries].sort((left, right) =>
      left.layer === "built-in" && right.layer === "built-in"
        ? (evidence.get(right.id)?.score ?? 0) - (evidence.get(left.id)?.score ?? 0)
        : 0,
    );
    return new FormatterCommandRegistry(entries, available, evidence);
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
    return selectConfiguredEntry(
      this.formatters,
      this.availableBuiltIns,
      this.evidence,
      filePath,
      projectRoot,
    );
  }

  /**
  Lists all merged entries in runtime resolution order.
  */
  public get entries(): readonly EffectiveToolConfigEntry<FormatterCommandConfig>[] {
    return this.formatters;
  }
}
