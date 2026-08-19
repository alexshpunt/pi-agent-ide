import { requestDiagnostics } from "./diagnostics.js";

import type { LspClient } from "./client.js";
import type { LspManager } from "./manager.js";
import type { Compiler, CompileResult, Diagnostic, ToolContext } from "pi-agent-ide/api/toolchain";

/**
 * Universal LSP-based Compiler for Gate.
 *
 * Priority 50 — lower than language-specific fast-path tools (tsc at 100),
 * higher than skip (0). Handles any language with a configured LSP server
 * that provides diagnostics capability.
 *
 * Syntax errors from LSP (severity=Error) trigger rollback in the Gate.
 */
export function createLspCompiler(manager: LspManager): Compiler
{
    let _client: LspClient | null = null;

    return {
        kind: "compiler",
        name: "lsp",
        priority: 100,
        extensions: ["*"],
        detect: () => Promise.resolve(true),
        async compile({ filePath }, ctx)
        {
            const result = await openAndDiagnose(filePath, ctx, manager);

            if (!result)
            {
                return skipOk();
            }

            const { client, diagnostics, syntaxErrors, otherDiagnostics } = result;
            _client = client;

            return {
                ok: syntaxErrors.length === 0,
                diagnostics,
                syntaxErrors,
                otherDiagnostics,
            };
        },
        async restart()
        {
            if (_client)
            {
                await _client.restart();
                _client = null;
            }
        },
    };
}

// ── shared helpers ───────────────────────────────────────────────────

async function openAndDiagnose(
    filePath: string,
    ctx: ToolContext,
    manager: LspManager,
): Promise<
    {
        client: LspClient;
        diagnostics: Diagnostic[];
        syntaxErrors: Diagnostic[];
        otherDiagnostics: Diagnostic[];
    } | null
>
{
    const opened = await manager.openFile(filePath, ctx.cwd);

    if (!opened)
    {
        return null;
    }

    const diag = await requestDiagnostics(opened.client, opened.uri, opened.languageId);
    return { client: opened.client, ...diag };
}

function skipOk(): CompileResult
{
    return { ok: true, diagnostics: [], syntaxErrors: [], otherDiagnostics: [] };
}
