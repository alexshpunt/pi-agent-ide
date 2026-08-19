import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    formatCodeViewReference,
    formatSourceViewResults,
    formatSymbolSelector,
    renderSourceViewLine,
    type SourceMappedTextContent,
    type SourceViewBlock,
} from "pi-agent-ide/api/code-view";

import { requestCallHierarchy, requestReferences } from "./navigation.js";
import { requestDocumentSymbols, symbolKindName } from "./symbols.js";

import type { LspClient } from "./client.js";
import type { LspManager } from "./manager.js";
import type { LspCallHierarchyResult, LspIncomingCall, LspLocation, LspOutgoingCall } from "./navigation.js";
import type { LspDocumentSymbol } from "./symbols.js";
import type { LspRange } from "./types.js";

const SOURCE_VIEW_FORMAT_OPTIONS = {
    failureLabel: "SYMBOL_READ_FAILED",
    emptyReason: "no symbol source was produced.",
} as const;
const MAX_GROUPS = 10;
const MAX_ITEMS_PER_GROUP = 5;
const MAX_CALLS = 10;

export interface LspCodeSymbol
{
    readonly name: string;
    readonly kind: number;
    readonly range: LspRange;
    readonly selectionRange: LspRange;
    readonly selector: readonly string[];
    readonly children: readonly LspCodeSymbol[];
}

interface LspCodeDocument
{
    readonly client: LspClient;
    readonly uri: string;
    readonly filePath: string;
    readonly displayPath: string;
    readonly symbols: readonly LspCodeSymbol[];
}

interface SymbolRelations
{
    readonly references: readonly LspLocation[];
    readonly calls: LspCallHierarchyResult;
}

export async function readLspSymbolBody(
    manager: LspManager,
    filePath: string,
    selector: readonly string[],
    cwd: string,
    signal?: AbortSignal,
): Promise<SourceMappedTextContent>
{
    throwIfAborted(signal);
    const document = await openCodeDocument(manager, filePath, cwd);
    const symbol = resolveLspCodeSymbol(document.symbols, selector, document.displayPath);
    const snapshot = await readTextFile(document.filePath);
    throwIfAborted(signal);

    const startLine = symbol.range.start.line + 1;
    const endLine = Math.min(symbol.range.end.line + 1, snapshot.lines.length);
    const renderedLines = snapshot.lines
        .slice(Math.max(0, startLine - 1), Math.max(0, endLine))
        .map((content, index) =>
        {
            const lineNumber = startLine + index;

            return renderSourceViewLine({
                content,
                sourceLine: {
                    source: document.filePath,
                    lineNumber,
                    content,
                },
            });
        });
    const block: SourceViewBlock = {
        path: document.displayPath,
        heading: `symbol: ${formatSymbolSelector(symbol.selector)}`,
        details: [
            `defined in: ${document.displayPath}:${startLine}-${endLine} (${symbolKindName(symbol.kind)})`,
        ],
        startLine,
        endLine,
        totalLines: snapshot.lines.length,
        renderedLines,
    };
    return formatSourceViewResults([block], SOURCE_VIEW_FORMAT_OPTIONS);
}

export async function readLspSymbolGraph(
    manager: LspManager,
    filePath: string,
    selector: readonly string[],
    cwd: string,
    signal?: AbortSignal,
): Promise<string>
{
    throwIfAborted(signal);
    const document = await openCodeDocument(manager, filePath, cwd);
    const symbol = resolveLspCodeSymbol(document.symbols, selector, document.displayPath);
    const relations = await queryRelations(document, symbol, signal);
    const locations = new LocationPresenter(cwd);
    return await formatSymbolGraph(document, symbol, relations, locations);
}

export async function readLspFileGraph(
    manager: LspManager,
    filePath: string,
    cwd: string,
    signal?: AbortSignal,
): Promise<string>
{
    throwIfAborted(signal);
    const document = await openCodeDocument(manager, filePath, cwd);
    const locations = new LocationPresenter(cwd);
    const lines = [
        `## file graph: ${document.displayPath}`,
        `Top-level declarations: ${document.symbols.length}`,
    ];

    for (const symbol of document.symbols)
    {
        throwIfAborted(signal);
        const relations = await queryRelations(document, symbol, signal);
        lines.push("", ...await formatFileGraphSymbol(document, symbol, relations, locations));
    }

    return lines.join("\n");
}

export function resolveLspCodeSymbol(
    symbols: readonly LspCodeSymbol[],
    selector: readonly string[],
    displayPath: string,
): LspCodeSymbol
{
    if (selector.length === 0)
    {
        throw new TypeError("A symbol selector must contain at least one segment.");
    }

    if (selector.length === 1)
    {
        const matches = collectNamedSymbols(symbols, selector[0]!);

        if (matches.length === 1)
        {
            return matches[0]!;
        }

        if (matches.length > 1)
        {
            throw new Error(
                `Symbol selector "${formatSymbolSelector(selector)}" is ambiguous in ${displayPath}; use parent/child.`,
            );
        }

        throw symbolNotFound(selector, displayPath);
    }

    let current = symbols;
    let selected: LspCodeSymbol | undefined;

    for (const segment of selector)
    {
        const matches = current.filter((symbol) => symbol.name === segment);

        if (matches.length === 0)
        {
            throw symbolNotFound(selector, displayPath);
        }

        if (matches.length > 1)
        {
            throw new Error(
                `Symbol selector "${formatSymbolSelector(selector)}" is ambiguous at "${segment}" in ${displayPath}.`,
            );
        }

        selected = matches[0]!;
        current = selected.children;
    }

    return selected!;
}

async function openCodeDocument(manager: LspManager, filePath: string, cwd: string): Promise<LspCodeDocument>
{
    const absolutePath = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
    const opened = await manager.openFile(absolutePath, cwd, "symbols");

    if (!opened)
    {
        throw new Error(`No LSP server with symbol support is configured for ${displayFilePath(absolutePath, cwd)}.`);
    }

    const rawSymbols = await requestDocumentSymbols(opened.client, opened.uri);
    const symbols = normalizeDocumentSymbols(rawSymbols).sort(compareSymbols);
    return {
        client: opened.client,
        uri: opened.uri,
        filePath: absolutePath,
        displayPath: displayFilePath(absolutePath, cwd),
        symbols,
    };
}

function normalizeDocumentSymbols(
    symbols: readonly LspDocumentSymbol[],
    parentSelector: readonly string[] = [],
): LspCodeSymbol[]
{
    return symbols.flatMap((symbol) =>
    {
        const selectionRange = symbol.selectionRange ?? symbol.range;

        if (!selectionRange)
        {
            return [];
        }

        const range = symbol.range ?? selectionRange;
        const selector = [...parentSelector, symbol.name];
        return [{
            name: symbol.name,
            kind: symbol.kind,
            range,
            selectionRange,
            selector,
            children: normalizeDocumentSymbols(symbol.children ?? [], selector).sort(compareSymbols),
        }];
    });
}

function compareSymbols(left: LspCodeSymbol, right: LspCodeSymbol): number
{
    return left.range.start.line - right.range.start.line
        || left.range.start.character - right.range.start.character
        || left.name.localeCompare(right.name);
}

function collectNamedSymbols(symbols: readonly LspCodeSymbol[], name: string): LspCodeSymbol[]
{
    return symbols.flatMap((symbol) => [
        ...(symbol.name === name ? [symbol] : []),
        ...collectNamedSymbols(symbol.children, name),
    ]);
}

function symbolNotFound(selector: readonly string[], displayPath: string): Error
{
    return new Error(`Symbol "${formatSymbolSelector(selector)}" was not found in ${displayPath}.`);
}

async function queryRelations(
    document: LspCodeDocument,
    symbol: LspCodeSymbol,
    signal: AbortSignal | undefined,
): Promise<SymbolRelations>
{
    const position = symbol.selectionRange.start;
    const [references, calls] = await Promise.all([
        optionalRequest(
            requestReferences(document.client, document.uri, position),
            [] as readonly LspLocation[],
            signal,
        ),
        optionalRequest(
            requestCallHierarchy(document.client, document.uri, position),
            { items: [], incoming: [], outgoing: [] },
            signal,
        ),
    ]);
    throwIfAborted(signal);
    return { references, calls };
}

async function optionalRequest<T>(request: Promise<T>, fallback: T, signal: AbortSignal | undefined): Promise<T>
{
    try
    {
        const result = await request;
        throwIfAborted(signal);
        return result;
    }
    catch (error)
    {
        if (signal?.aborted === true)
        {
            throw abortReason(signal, error);
        }

        return fallback;
    }
}

async function formatSymbolGraph(
    document: LspCodeDocument,
    symbol: LspCodeSymbol,
    relations: SymbolRelations,
    locations: LocationPresenter,
): Promise<string>
{
    const selector = formatSymbolSelector(symbol.selector);
    const definitionAnchor = await locations.line(document.uri, symbol.selectionRange.start.line + 1);
    const lines = [
        `## graph: ${selector}`,
        `Definition: ${document.displayPath} ${definitionAnchor} (${symbolKindName(symbol.kind)})`,
        `Source: ${formatCodeViewReference("graph", document.displayPath, symbol.selector)}`,
        "",
        ...await formatReferences(relations.references, locations),
        "",
        ...await formatIncomingCalls(relations.calls.incoming, locations),
        "",
        ...await formatOutgoingCalls(relations.calls.outgoing, locations),
    ];
    return lines.join("\n");
}

async function formatReferences(
    references: readonly LspLocation[],
    locations: LocationPresenter,
): Promise<string[]>
{
    const groups = groupLocationsByUri(references);
    const lines = [`References: ${references.length} in ${groups.length} file(s)`];

    for (const [uri, items] of groups.slice(0, MAX_GROUPS))
    {
        lines.push(`- ${locations.display(uri)} (${items.length})`);

        for (const item of items.slice(0, MAX_ITEMS_PER_GROUP))
        {
            lines.push(`  - ${await locations.line(uri, item.range.start.line + 1)}`);
        }

        if (items.length > MAX_ITEMS_PER_GROUP)
        {
            lines.push(`  - ... ${items.length - MAX_ITEMS_PER_GROUP} more`);
        }
    }

    if (groups.length > MAX_GROUPS)
    {
        lines.push(`- ... ${groups.length - MAX_GROUPS} more file(s)`);
    }

    return lines;
}

async function formatIncomingCalls(
    calls: readonly LspIncomingCall[],
    locations: LocationPresenter,
): Promise<string[]>
{
    const lines = [`Incoming calls: ${calls.length}`];

    for (const call of calls.slice(0, MAX_CALLS))
    {
        const line = call.fromRanges[0]?.start.line ?? call.from.selectionRange.start.line;
        const anchor = await locations.line(call.from.uri, line + 1);
        lines.push(
            `- ${symbolKindName(call.from.kind)} ${call.from.name} — ${locations.display(call.from.uri)} ${anchor}`,
        );
    }

    if (calls.length > MAX_CALLS)
    {
        lines.push(`- ... ${calls.length - MAX_CALLS} more`);
    }

    return lines;
}

async function formatOutgoingCalls(
    calls: readonly LspOutgoingCall[],
    locations: LocationPresenter,
): Promise<string[]>
{
    const lines = [`Outgoing calls: ${calls.length}`];

    for (const call of calls.slice(0, MAX_CALLS))
    {
        const anchor = await locations.line(call.to.uri, call.to.selectionRange.start.line + 1);
        lines.push(`- ${symbolKindName(call.to.kind)} ${call.to.name} — ${locations.display(call.to.uri)} ${anchor}`);
    }

    if (calls.length > MAX_CALLS)
    {
        lines.push(`- ... ${calls.length - MAX_CALLS} more`);
    }

    return lines;
}

async function formatFileGraphSymbol(
    document: LspCodeDocument,
    symbol: LspCodeSymbol,
    relations: SymbolRelations,
    locations: LocationPresenter,
): Promise<string[]>
{
    const kind = symbolKindName(symbol.kind);
    const definitionAnchor = await locations.line(document.uri, symbol.selectionRange.start.line + 1);
    const referenceFiles = groupLocationsByUri(relations.references)
        .map(([uri, items]) => `${locations.display(uri)} (${items.length})`);
    const incoming = relations.calls.incoming.map((call) => `${call.from.name} (${locations.display(call.from.uri)})`);
    const outgoing = relations.calls.outgoing.map((call) => `${call.to.name} (${locations.display(call.to.uri)})`);
    const lines = [
        `### ${kind} ${symbol.name}`,
        `Selector: ${formatSymbolSelector(symbol.selector)}`,
        `Definition: ${definitionAnchor}`,
        `Used by: ${summarize(referenceFiles)}`,
        `Incoming calls: ${summarize(incoming)}`,
        `Outgoing calls: ${summarize(outgoing)}`,
    ];

    if (symbol.children.length > 0)
    {
        lines.push("Members:");

        for (const child of symbol.children)
        {
            const source = formatCodeViewReference("graph", document.displayPath, child.selector);
            lines.push(`- ${symbolKindName(child.kind)} ${child.name} — ${source}`);
        }
    }

    return lines;
}

function summarize(items: readonly string[], limit = 5): string
{
    if (items.length === 0)
    {
        return "none";
    }

    const shown = items.slice(0, limit).join(", ");
    return items.length > limit ? `${shown}, ... ${items.length - limit} more` : shown;
}

function groupLocationsByUri(locations: readonly LspLocation[]): [string, LspLocation[]][]
{
    const grouped = new Map<string, LspLocation[]>();

    for (const location of locations)
    {
        const current = grouped.get(location.uri) ?? [];
        current.push(location);
        grouped.set(location.uri, current);
    }

    return [...grouped.entries()]
        .map(([uri, items]) =>
            [
                uri,
                items.sort((left, right) =>
                    left.range.start.line - right.range.start.line
                    || left.range.start.character - right.range.start.character
                ),
            ] as [string, LspLocation[]]
        )
        .sort(([left], [right]) => left.localeCompare(right));
}

interface TextFileSnapshot
{
    readonly lines: string[];
    readonly content: string;
}

async function readTextFile(filePath: string): Promise<TextFileSnapshot>
{
    const buffer = await readFile(filePath);

    if (buffer.byteLength > 256 * 1024)
    {
        throw new Error(`File exceeds the 262144-byte code-view limit: ${filePath}`);
    }

    if (buffer.includes(0))
    {
        throw new Error(`File appears to be binary and cannot be read as text: ${filePath}`);
    }

    const content = buffer.toString("utf8").replaceAll("\r\n", "\n");
    const withoutFinalNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
    const lines = withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split("\n");

    return { content, lines };
}

class LocationPresenter
{
    readonly #cwd: string;

    public constructor(cwd: string)
    {
        this.#cwd = cwd;
    }

    public display(uri: string): string
    {
        return displayFilePath(filePathFromUri(uri), this.#cwd);
    }

    public line(_uri: string, lineNumber: number): Promise<string>
    {
        return Promise.resolve(String(lineNumber));
    }
}

function filePathFromUri(uri: string): string
{
    if (!uri.startsWith("file://"))
    {
        return uri;
    }

    try
    {
        return fileURLToPath(uri);
    }
    catch
    {
        return decodeURIComponent(uri.slice("file://".length));
    }
}

function displayFilePath(filePath: string, cwd: string): string
{
    const relative = path.relative(cwd, filePath);

    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative))
    {
        return filePath;
    }

    return relative.replaceAll(path.sep, "/");
}

function throwIfAborted(signal: AbortSignal | undefined): void
{
    if (signal?.aborted === true)
    {
        throw abortReason(signal);
    }
}

function abortReason(signal: AbortSignal, fallback?: unknown): Error
{
    if (signal.reason instanceof Error)
    {
        return signal.reason;
    }

    if (fallback instanceof Error)
    {
        return fallback;
    }

    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
}
