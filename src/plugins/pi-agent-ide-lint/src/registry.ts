import { readFile } from "node:fs/promises";
import path from "node:path";

import type { LintCommandConfig, LintersConfig } from "./types.js";

export class LintCommandRegistry
{
    private constructor(private readonly linters: readonly LintCommandConfig[])
    {}

    public static async fromDirectory(directory: string): Promise<LintCommandRegistry>
    {
        const raw = await readFile(path.join(directory, "linters.json"), "utf8");
        return LintCommandRegistry.fromConfig(JSON.parse(raw) as LintersConfig);
    }

    public static fromConfig(config: LintersConfig): LintCommandRegistry
    {
        return new LintCommandRegistry(Object.values(config.linters));
    }

    public resolve(extension: string): LintCommandConfig | undefined
    {
        const normalized = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
        return this.linters.find((linter) =>
            linter.command.length > 0
            && linter.extensions.some((candidate) => candidate.toLowerCase() === normalized)
        );
    }
}
