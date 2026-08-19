import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

import { TextAnchor } from "pi-agent-text";
import * as WTS from "web-tree-sitter";

export interface ScopeEntry
{
    readonly name: string;
    readonly kind: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly depth: number;
    readonly hash: string;
    readonly blockHash: string;
    readonly occurrence?: number;
    readonly beginAnchor: TextAnchor;
    readonly endScopeAnchor: TextAnchor;
    readonly scopeBeginAnchor: TextAnchor;
    readonly scopeEndAnchor: TextAnchor;
}

const require = createRequire(import.meta.url);

interface ScopeCandidate
{
    readonly startLine: number;
    readonly endLine: number;
    readonly kind: string;
    /** True if this candidate came from a named body field (step 1). */
    readonly fromBodyField: boolean;
}

const ROOT_KINDS = new Set([
    "program",
    "module",
]);

/** Named AST fields that represent block-level bodies. */
const BODY_FIELDS = new Set([
    "body",
    "consequence",
    "alternative",
    "handler",
    "finalizer",
]);

let initPromise: Promise<void> | undefined;
const loadedLanguages = new Map<string, Promise<WTS.Language>>();

function grammarWasmPath(ext: string): string | undefined
{
    switch (ext)
    {
        case ".ts":
        case ".tsx":
        {
            return "tree-sitter-typescript/tree-sitter-typescript.wasm";
        }

        case ".js":
        case ".jsx":
        case ".mjs":
        case ".cjs":
        {
            return "tree-sitter-javascript/tree-sitter-javascript.wasm";
        }

        case ".py":
        {
            return "tree-sitter-python/tree-sitter-python.wasm";
        }

        case ".rs":
        {
            return "tree-sitter-rust/tree-sitter-rust.wasm";
        }

        case ".c":
        case ".cpp":
        case ".cxx":
        case ".h":
        case ".hpp":
        {
            return "tree-sitter-cpp/tree-sitter-cpp.wasm";
        }
        case ".json":
        case ".jsonc":
        {
            return "tree-sitter-json/tree-sitter-json.wasm";
        }

        case ".yaml":
        case ".yml":
        {
            return "@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm";
        }

        case ".toml":
        {
            return "@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm";
        }

        default:
        {
            return undefined;
        }
    }
}

async function ensureParser(ext: string): Promise<WTS.Parser | undefined>
{
    const wasmRelPath = grammarWasmPath(ext);

    if (!wasmRelPath)
    {
        return undefined;
    }

    initPromise ??= WTS.Parser.init();

    await initPromise;

    let languageLoad = loadedLanguages.get(wasmRelPath);

    if (languageLoad === undefined)
    {
        const wasmAbsolute = require.resolve(wasmRelPath);
        languageLoad = WTS.Language.load(wasmAbsolute);
        loadedLanguages.set(wasmRelPath, languageLoad);
    }

    const language = await languageLoad;
    const parser = new WTS.Parser();
    parser.setLanguage(language);
    return parser;
}

export async function parseDocument(
    filePath: string,
    cwd: string,
    lines: readonly string[],
): Promise<WTS.Tree | undefined>
{
    if (lines.length === 0)
    {
        return undefined;
    }

    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const parser = await ensureParser(path.extname(absolutePath).toLowerCase());

    if (!parser)
    {
        return undefined;
    }

    return parser.parse(lines.join("\n")) ?? undefined;
}

function hashScope(lines: readonly string[], startLine: number, endLine: number): string
{
    const text = lines.slice(Math.max(0, startLine - 1), Math.max(0, endLine)).join("\n");
    return createHash("sha1").update(text).digest("hex").slice(0, 4).toUpperCase();
}

class AstScopeTextAnchor extends TextAnchor
{
    public constructor(
        boundary: "begin" | "end",
        hash: string,
        lineNumber: number,
        occurrence?: number,
    )
    {
        super(`scope-${boundary}-${hash}${occurrence === undefined ? "" : `-${occurrence}`}`, lineNumber);
    }
}

function createScopeAnchor(
    boundary: "begin" | "end",
    hash: string,
    lineNumber: number,
    occurrence?: number,
): TextAnchor
{
    return new AstScopeTextAnchor(boundary, hash, lineNumber, occurrence);
}

/** Scope discovery via web-tree-sitter full AST walk. */
export class AstScopeManager
{
    public async getDocumentScopes(
        filePath: string,
        cwd: string,
        lines: readonly string[],
    ): Promise<ScopeEntry[]>
    {
        if (lines.length === 0)
        {
            return [];
        }

        const tree = await parseDocument(filePath, cwd, lines);

        if (!tree)
        {
            return [];
        }

        const candidates: ScopeCandidate[] = [];
        this.collectCandidates(tree.rootNode, candidates);

        return this.buildEntries(candidates, lines);
    }

    private collectCandidates(node: WTS.Node, candidates: ScopeCandidate[], depth = 0, isBodyChild = false): void
    {
        if (depth > 100)
        {
            return;
        }

        if (!node.isNamed)
        {
            return;
        }

        const nodeType = node.type;

        if (!nodeType || ROOT_KINDS.has(nodeType))
        {
            // Root nodes (program, module) — still recurse into children
            for (const child of node.namedChildren)
            {
                this.collectCandidates(child, candidates, depth + 1);
            }

            return;
        }

        // 1. Collect block bodies from named fields (body, consequence, alternative, etc.)
        for (const fieldName of BODY_FIELDS)
        {
            const child = node.childForFieldName(fieldName);

            if (!child?.isNamed)
            {
                continue;
            }

            const startLine = child.startPosition.row + 1;
            const endLine = child.endPosition.row + 1;
            const isMultiLine = endLine - startLine >= 3;

            // If the child itself has a body field (e.g. catch_clause → body),
            // skip registering the intermediate node — recurse into it so its
            // inner body gets registered instead.
            const hasOwnBody = [...BODY_FIELDS].some((f) => child.childForFieldName(f) !== null);

            if (isMultiLine && !hasOwnBody)
            {
                candidates.push({ startLine, endLine, kind: `${nodeType}.${fieldName}`, fromBodyField: true });
            }

            this.collectCandidates(child, candidates, depth + 1, true);
        }

        // 2. Generic fallback: any named multi-line node with children is a scope,
        //    unless it already has a body field (handled by step 1).
        const hasAnyBodyField = [...BODY_FIELDS].some((f) => node.childForFieldName(f) !== null);

        if (!hasAnyBodyField && !isBodyChild)
        {
            const nodeStartLine = node.startPosition.row + 1;
            const nodeEndLine = node.endPosition.row + 1;

            if (nodeEndLine - nodeStartLine >= 3 && node.namedChildren.length > 0)
            {
                candidates.push({
                    startLine: nodeStartLine,
                    endLine: nodeEndLine,
                    kind: nodeType,
                    fromBodyField: false,
                });
            }
        }

        // 3. Recurse into all named children (to find nested constructs)
        for (const child of node.namedChildren)
        {
            this.collectCandidates(child, candidates, depth + 1);
        }
    }

    private buildEntries(candidates: readonly ScopeCandidate[], lines: readonly string[]): ScopeEntry[]
    {
        const byStart = new Map<number, ScopeCandidate>();

        for (const candidate of candidates)
        {
            const current = byStart.get(candidate.startLine);

            if (
                !current
                || candidate.endLine > current.endLine
                || (candidate.endLine === current.endLine && candidate.fromBodyField && !current.fromBodyField)
            )
            {
                byStart.set(candidate.startLine, candidate);
            }
        }

        const ordered = [...byStart.values()].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);

        // Filter: nested scopes sharing an endLine with their outer parent are redundant.
        // The outermost scope with a given endLine wins.
        const deduped: ScopeCandidate[] = [];

        for (const candidate of ordered)
        {
            const hasOuterWithSameEnd = deduped.some(
                (existing) =>
                    existing.startLine < candidate.startLine
                    && existing.endLine === candidate.endLine,
            );

            if (!hasOuterWithSameEnd)
            {
                deduped.push(candidate);
            }
        }

        const counts = new Map<string, number>();

        for (const candidate of deduped)
        {
            const hash = hashScope(lines, candidate.startLine, candidate.endLine);
            counts.set(hash, (counts.get(hash) ?? 0) + 1);
        }

        const seen = new Map<string, number>();

        return deduped.map((candidate) =>
        {
            const hash = hashScope(lines, candidate.startLine, candidate.endLine);
            const total = counts.get(hash) ?? 1;
            const occurrence = (seen.get(hash) ?? 0) + 1;
            seen.set(hash, occurrence);
            const occurrenceSuffix = total > 1 ? occurrence : undefined;

            return {
                name: candidate.kind,
                kind: candidate.kind,
                startLine: candidate.startLine,
                endLine: candidate.endLine,
                depth: deduped.filter((parent) =>
                    parent !== candidate
                    && parent.startLine <= candidate.startLine
                    && parent.endLine >= candidate.endLine
                    && (parent.startLine < candidate.startLine || parent.endLine > candidate.endLine)
                ).length,
                hash,
                blockHash: hash,
                ...(occurrenceSuffix === undefined ? {} : { occurrence: occurrenceSuffix }),
                beginAnchor: createScopeAnchor("begin", hash, candidate.startLine, occurrenceSuffix),
                endScopeAnchor: createScopeAnchor("end", hash, candidate.endLine, occurrenceSuffix),
                scopeBeginAnchor: createScopeAnchor("begin", hash, candidate.startLine, occurrenceSuffix),
                scopeEndAnchor: createScopeAnchor("end", hash, candidate.endLine, occurrenceSuffix),
            } satisfies ScopeEntry;
        });
    }
}
