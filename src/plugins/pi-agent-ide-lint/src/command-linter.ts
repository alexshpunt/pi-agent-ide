import { writeFile } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "./command-runner.js";
import { LintCommandRegistry } from "./registry.js";

import type { Diagnostic, Linter } from "pi-agent-ide/api/toolchain";

const LINE_PATTERN = /^(.+?):(\d+):(\d+):\s*(.+)$/;

export function createCommandLinter(registry: LintCommandRegistry): Linter
{
    return {
        kind: "linter",
        name: "command-lint",
        priority: 100,
        extensions: ["*"],
        detect: () => Promise.resolve(true),
        async lint({ filePath, fix }, context)
        {
            const configured = registry.resolve(path.extname(filePath));
            const executable = configured?.command[0];

            if (configured === undefined || executable === undefined)
            {
                return { ok: true, diagnostics: [] };
            }

            const configuredArguments = configured.command.slice(1)
                .filter((argument) => fix !== false || argument !== "--fix");
            const separator = configuredArguments.indexOf("--");
            const arguments_ = separator === -1
                ? [...configuredArguments, filePath]
                : [
                    ...configuredArguments.slice(0, separator),
                    filePath,
                    ...configuredArguments.slice(separator),
                ];
            const result = await runCommand(executable, arguments_, { cwd: context.cwd, timeoutMs: 30_000 });
            const output = result.stdout.trim() || result.stderr.trim();

            if (fix === true)
            {
                const fixed = parseFixedOutput(output);

                if (fixed !== undefined)
                {
                    await writeFile(filePath, fixed, "utf8");
                }
            }

            return { ok: true, diagnostics: parseLintOutput(output) };
        },
    };
}

function parseFixedOutput(output: string): string | undefined
{
    if (!output.startsWith("["))
    {
        return undefined;
    }

    try
    {
        const results = JSON.parse(output) as { output?: unknown; }[];
        const fixed = results.find((result) => typeof result.output === "string")?.output;
        return typeof fixed === "string" ? fixed : undefined;
    }
    catch
    {
        return undefined;
    }
}

function parseLintOutput(output: string): Diagnostic[]
{
    if (output.length === 0)
    {
        return [];
    }

    if (output.startsWith("["))
    {
        try
        {
            const results = JSON.parse(output) as {
                messages: { line: number; column: number; message: string; ruleId: string | null; }[];
            }[];
            return results.flatMap((file) =>
                file.messages.map((message) => ({
                    code: message.ruleId ?? "lint",
                    message: message.message,
                    line: message.line,
                    column: message.column,
                    severity: "warning" as const,
                }))
            );
        }
        catch
        {
            return [];
        }
    }

    return output.split("\n").flatMap((line): Diagnostic[] =>
    {
        if (line.startsWith("Found ") || line.startsWith("All checks passed"))
        {
            return [];
        }

        const match = line.match(LINE_PATTERN);

        if (match === null)
        {
            return [];
        }

        return [{
            code: "lint",
            line: Number.parseInt(match[2]!, 10),
            column: Number.parseInt(match[3]!, 10),
            message: match[4]!.replace(/\[\*\]\s*/, "").replace(/^warning:\s*/i, ""),
            severity: "warning",
        }];
    });
}

export function createConfiguredCommandLinter(): Linter
{
    let registryCwd: string | undefined;
    let registryReady: Promise<LintCommandRegistry> | undefined;

    const registryFor = (cwd: string): Promise<LintCommandRegistry> =>
    {
        if (registryReady === undefined || registryCwd !== cwd)
        {
            registryCwd = cwd;
            registryReady = LintCommandRegistry.fromDirectory(cwd).catch(() =>
                LintCommandRegistry.fromConfig({ linters: {} })
            );
        }

        return registryReady;
    };

    return {
        kind: "linter",
        name: "command-lint",
        priority: 100,
        extensions: ["*"],
        detect: () => Promise.resolve(true),
        async lint(input, context)
        {
            const registry = await registryFor(context.cwd);
            return createCommandLinter(registry).lint(input, context);
        },
    };
}
