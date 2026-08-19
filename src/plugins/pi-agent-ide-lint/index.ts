import { readFile } from "node:fs/promises";
import path from "node:path";

import {
    createDiagnosticViewContent,
    createSourceMappedTextReadHandler,
    formatDiagnosticViewSource,
    resolveDiagnosticViewPath,
} from "pi-agent-ide/api/code-view";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdePlugin } from "pi-agent-ide/api/plugin-protocol";
import { type Diagnostic, formatDiagnostic, type IdeTool } from "pi-agent-ide/api/toolchain";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL, type ReadPlugin } from "pi-agent-read/api/plugin-protocol";
import { createReadResultRenderer } from "pi-agent-read/api/rendering";

import { createCommandLinter } from "./src/command-linter.js";
import { LintCommandRegistry } from "./src/registry.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResourceResolutionAttempt, ResourceResolver } from "pi-agent-resource";
import type { TextDocument, TextLinePresenter } from "pi-agent-text";

const renderDiagnosticReadResult = createReadResultRenderer({ kind: "code-view", label: "Lint" });

export default async function registerLint(pi: ExtensionAPI): Promise<void>
{
    let registryCwd: string | undefined;
    let registryReady: Promise<LintCommandRegistry> | undefined;
    const registryFor = (cwd: string): Promise<LintCommandRegistry> =>
    {
        if (registryReady === undefined || registryCwd !== cwd)
        {
            registryCwd = cwd;
            registryReady = loadRegistry(cwd);
        }

        return registryReady;
    };

    const linter = {
        kind: "linter",
        name: "pi-agent-ide-lint",
        priority: 200,
        extensions: ["*"],
        detect: async (context) =>
        {
            await registryFor(context.cwd);
            return true;
        },
        async lint(input, context)
        {
            const readyRegistry = await registryFor(context.cwd);
            return createCommandLinter(readyRegistry).lint(input, context);
        },
    } satisfies IdeTool;
    const idePlugin = {
        protocol: IDE_PROTOCOL,
        apiVersion: IDE_API_VERSION,
        id: "lint",
        setup(api): void
        {
            api.addTool(linter);
        },
    } satisfies IdePlugin;
    const readPlugin = {
        protocol: READ_PROTOCOL,
        apiVersion: READ_API_VERSION,
        id: "lint",
        setup(api)
        {
            api.addResolver({
                resolver: createLintDiagnosticResolver(registryFor),
                renderResult: renderDiagnosticReadResult,
            });
            api.addHandler({
                stage: "read",
                when: { resolvedBy: "lint-diagnostics", contentKind: "text" },
                handler: createSourceMappedTextReadHandler(),
            });
            api.addTextPresenter({
                priority: 100,
                presenter: createLintReadPresenter(registryFor),
            });
            api.describe(
                "Adds lint diagnostics to textual read results without applying fixes. Use `lint:<path>` to read only lines with lint diagnostics.",
            );
        },
    } satisfies ReadPlugin;

    await Promise.all([
        connectIdePlugin(pi, idePlugin),
        connectReadPlugin(pi, readPlugin),
    ]);
}

function createLintDiagnosticResolver(
    getRegistry: (cwd: string) => Promise<LintCommandRegistry>,
): ResourceResolver
{
    return {
        id: "lint-diagnostics",
        tryResolve(source, context)
        {
            return Promise.resolve(resolveLintDiagnosticSource(source, context.cwd, getRegistry));
        },
    };
}

function resolveLintDiagnosticSource(
    source: string,
    cwd: string,
    getRegistry: (cwd: string) => Promise<LintCommandRegistry>,
): ResourceResolutionAttempt
{
    let filePath: string | undefined;

    try
    {
        filePath = resolveDiagnosticViewPath(source, "lint", cwd);
    }
    catch (error)
    {
        return { kind: "failed", error };
    }

    if (filePath === undefined)
    {
        return { kind: "not-handled" };
    }

    return {
        kind: "resolved",
        resource: {
            source: formatDiagnosticViewSource("lint", filePath),
            async read()
            {
                const [text, registry] = await Promise.all([
                    readFile(filePath, "utf8"),
                    getRegistry(cwd),
                ]);
                const linted = await createCommandLinter(registry).lint(
                    { filePath, fix: false },
                    { cwd },
                );
                return [createDiagnosticViewContent(filePath, text, linted.diagnostics, "lint")];
            },
        },
    };
}

function createLintReadPresenter(
    getRegistry: (cwd: string) => Promise<LintCommandRegistry>,
): TextLinePresenter
{
    return {
        id: "lint-diagnostics",
        async present(document, context)
        {
            const source = document.source;

            if (context.purpose !== "read" || !path.isAbsolute(source))
            {
                return document;
            }

            try
            {
                const registry = await getRegistry(context.cwd);
                const linted = await createCommandLinter(registry).lint(
                    { filePath: source, fix: false },
                    { cwd: context.cwd },
                );
                return addDiagnostics(document, linted.diagnostics, "lint");
            }
            catch
            {
                return document;
            }
        },
    };
}

function addDiagnostics(
    document: TextDocument,
    diagnostics: readonly Diagnostic[],
    source: string,
): TextDocument
{
    const diagnosticsByLine = new Map<number, string[]>();

    for (const diagnostic of diagnostics)
    {
        const annotations = diagnosticsByLine.get(diagnostic.line) ?? [];
        annotations.push(`<!-- ${source}: ${formatDiagnostic(diagnostic, source)} -->`);
        diagnosticsByLine.set(diagnostic.line, annotations);
    }

    if (diagnosticsByLine.size === 0)
    {
        return document;
    }

    const lines = document.lines.map((line) =>
    {
        const annotations = diagnosticsByLine.get(line.lineNumber);

        if (annotations === undefined)
        {
            return line;
        }

        return {
            ...line,
            presentation: {
                ...line.presentation,
                suffix: `${line.presentation?.suffix ?? ""}  ${annotations.join(" ")}`,
            },
        };
    });

    return { ...document, lines };
}

async function loadRegistry(cwd: string): Promise<LintCommandRegistry>
{
    const configDirectory = process.env.PI_AGENT_IDE_CONFIG_DIR ?? cwd;

    try
    {
        return await LintCommandRegistry.fromDirectory(configDirectory);
    }
    catch
    {
        return LintCommandRegistry.fromConfig({ linters: {} });
    }
}
