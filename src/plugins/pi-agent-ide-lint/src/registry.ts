import { inspectRecipeEvidence } from "pi-agent-doctor/api/evidence";
import { LINTER_RECIPES } from "./catalog.js";

import {
  hasConfiguredExecutable,
  loadLayeredToolConfig,
  selectConfiguredEntry,
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

    private readonly evidence: ReadonlyMap<string, { readonly score: number }> = new Map(),
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
    const evidence = await inspectRecipeEvidence(directory, LINTER_RECIPES);
    const entries = [...effective.entries].sort((left, right) =>
      left.layer === "built-in" && right.layer === "built-in"
        ? (evidence.get(right.id)?.score ?? 0) - (evidence.get(left.id)?.score ?? 0)
        : 0,
    );
    return new LintCommandRegistry(
      entries,
      new Set(available.filter((entry) => entry.available).map((entry) => entry.id)),

      evidence,
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
    return selectConfiguredEntry(
      this.linters,
      this.availableBuiltIns,
      this.evidence,
      filePath,
      projectRoot,
    );
  }

  /**
  Lists all merged entries in runtime resolution order.
  */
  public get entries(): readonly EffectiveToolConfigEntry<LinterCommandConfig>[] {
    return this.linters;
  }
}
