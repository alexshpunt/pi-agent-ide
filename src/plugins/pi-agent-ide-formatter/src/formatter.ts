import { spawnSync } from "node:child_process";

import { FormatterCommandRegistry } from "./registry.js";

import type { Formatter } from "pi-agent-ide/api/toolchain";

const registries = new Map<string, Promise<FormatterCommandRegistry | undefined>>();

/** Creates a formatter that runs a configured external process. */
export function createFormatter(): Formatter
{
    return {
        kind: "formatter",
        name: "formatter",
        priority: 100,
        extensions: ["*"],
        detect: () => Promise.resolve(true),
        async format({ filePath }, ctx)
        {
            const registry = await loadRegistry(ctx.cwd);
            const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
            const formatter = registry?.resolve(ext);

            if (!formatter)
            {
                return { ok: true, edits: 0 };
            }

            const result = spawnSync(formatter.command[0]!, [...formatter.command.slice(1), filePath], {
                cwd: ctx.cwd,
            });
            return { ok: result.status === 0, edits: result.status === 0 ? 1 : 0 };
        },
    };
}

async function loadRegistry(cwd: string): Promise<FormatterCommandRegistry | undefined>
{
    let registry = registries.get(cwd);

    if (registry === undefined)
    {
        registry = FormatterCommandRegistry.fromDirectory(cwd).catch((): undefined =>
        {
        });
        registries.set(cwd, registry);
    }

    return registry;
}
