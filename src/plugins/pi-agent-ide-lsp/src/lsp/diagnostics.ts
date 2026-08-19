import { readFile } from "node:fs/promises";

import { URI } from "vscode-uri";

import { DiagnosticSeverity, type LspDiagnostic } from "./types.js";

import type { LspClient } from "./client.js";
import type { Diagnostic, Severity } from "pi-agent-ide/api/toolchain";

/**
 * Request diagnostics from an LSP server for a document.
 *
 * Returns IDE Diagnostic[] with proper severity classification
 * suitable for both compiler (syntax errors cause rollback) and linter
 * (warnings are informational only).
 */
export async function requestDiagnostics(client: LspClient, uri: string, languageId?: string): Promise<{
    diagnostics: Diagnostic[];
    syntaxErrors: Diagnostic[];
    otherDiagnostics: Diagnostic[];
}>
{
    // Try pull-model first (LSP 3.17+). Fall back to push notifications.
    try
    {
        const raw = await client.sendRequest<LspDiagnosticResult>("textDocument/diagnostic", {
            textDocument: { uri },
        });
        client.setDiagnosticMode("pull");
        return classify(toDiagnostics(raw.items));
    }
    catch (error)
    {
        if (isMethodNotFound(error))
        {
            // Server doesn't support pull model — check if it supports diagnostics at all
            if (!client.hasServerDiagnosticsCapability)
            {
                return classify([]);
            }

            client.setDiagnosticMode("push");
            return await waitForPushDiagnostics(client, uri, languageId);
        }

        throw error;
    }
}

// ── LSP types ───────────────────────────────────────────────────────

interface LspDiagnosticResult
{
    kind: "full";
    items: LspDiagnostic[];
}

// ── conversion ───────────────────────────────────────────────────────

/** Convert an LSP diagnostic to a Gate Diagnostic (1-based coordinates). */
function toGateDiagnostic(d: LspDiagnostic): Diagnostic
{
    return {
        code: typeof d.code === "number" ? String(d.code) : (d.code ?? "LSP"),
        message: d.message,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity: lspSeverityToGate(d.severity),
    };
}

/** Map LSP DiagnosticSeverity (1-4) to Gate Severity. */
function lspSeverityToGate(severity: DiagnosticSeverity): Severity
{
    switch (severity)
    {
        case DiagnosticSeverity.Error:
        {
            return "error";
        }
        case DiagnosticSeverity.Warning:
        {
            return "warning";
        }
        case DiagnosticSeverity.Information:
        {
            return "info";
        }
        case DiagnosticSeverity.Hint:
        {
            return "hint";
        }
    }
}

// ── helpers ───────────────────────────────────────────────────────────

function toDiagnostics(items: LspDiagnostic[]): Diagnostic[]
{
    return items.map((d) => toGateDiagnostic(d));
}

function classify(diags: Diagnostic[]): {
    diagnostics: Diagnostic[];
    syntaxErrors: Diagnostic[];
    otherDiagnostics: Diagnostic[];
}
{
    const syntaxErrors = diags.filter((d) => d.severity === "error");
    const otherDiagnostics = diags.filter((d) => d.severity !== "error");
    return { diagnostics: diags, syntaxErrors, otherDiagnostics };
}

function isMethodNotFound(err: unknown): boolean
{
    return err !== null && typeof err === "object" && "code" in err && (err as { code: number; }).code === -32601;
}

/** Wait for a push diagnostic notification after synchronizing the document. */
async function waitForPushDiagnostics(client: LspClient, uri: string, languageId?: string): Promise<{
    diagnostics: Diagnostic[];
    syntaxErrors: Diagnostic[];
    otherDiagnostics: Diagnostic[];
}>
{
    const text = await readFile(URI.parse(uri).fsPath, "utf8").catch(() => null);

    if (text === null)
    {
        return classify([]);
    }

    const langId = languageId ?? uri.split(".").pop()?.toLowerCase() ?? "";
    client.beginDiagnosticRequest(uri);

    try
    {
        const items = await new Promise<LspDiagnostic[]>((resolve) =>
        {
            let settled = false;
            const unsubscribe = client.onNotification("textDocument/publishDiagnostics", (params) =>
            {
                const notification = params as { uri?: unknown; diagnostics?: unknown; };

                if (notification.uri !== uri || !Array.isArray(notification.diagnostics))
                {
                    return;
                }

                finish(notification.diagnostics as LspDiagnostic[]);
            });
            const timeout = setTimeout(() =>
            {
                finish([]);
            }, 500);

            function finish(diagnostics: LspDiagnostic[]): void
            {
                if (settled)
                {
                    return;
                }

                settled = true;
                clearTimeout(timeout);
                unsubscribe();
                resolve(diagnostics);
            }

            client.syncDocument(uri, text, langId);
        });

        return classify(toDiagnostics(items));
    }
    finally
    {
        client.endDiagnosticRequest(uri);
    }
}
