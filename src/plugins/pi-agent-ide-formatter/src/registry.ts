import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FormatterCommandConfig, FormattersConfig } from "./types.js";

export class FormatterCommandRegistry
{
    private constructor(private readonly formatters: readonly FormatterCommandConfig[])
    {}

    public static async fromDirectory(directory: string): Promise<FormatterCommandRegistry>
    {
        const raw = await readFile(path.join(directory, "formatters.json"), "utf8");
        return FormatterCommandRegistry.fromConfig(JSON.parse(raw) as FormattersConfig);
    }

    public static fromConfig(config: FormattersConfig): FormatterCommandRegistry
    {
        return new FormatterCommandRegistry(Object.values(config.formatters));
    }

    public resolve(extension: string): FormatterCommandConfig | undefined
    {
        const normalized = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
        return this.formatters.find((formatter) =>
            formatter.command.length > 0
            && formatter.extensions.some((candidate) => candidate.toLowerCase() === normalized)
        );
    }
}
