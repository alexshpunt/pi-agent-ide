import { createRequire } from "node:module";
import path from "node:path";

import { lineAnchors, TextAnchor } from "pi-agent-text";
import * as WTS from "web-tree-sitter";

import { parseNativeDocument } from "./native-parser.ts";
import type { SyntaxNode, SyntaxTree } from "./syntax-tree.ts";

export interface ScopeEntry {
  readonly name: string;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly depth: number;
  /** The line anchor of the scope's first line, which names the scope. */
  readonly hash: string;
  readonly blockHash: string;
  readonly beginAnchor: TextAnchor;
  readonly endScopeAnchor: TextAnchor;
  readonly scopeBeginAnchor: TextAnchor;
  readonly scopeEndAnchor: TextAnchor;
}

const require = createRequire(import.meta.url);

interface ScopeCandidate {
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: string;
  /**
    True if this candidate came from a named body field (step 1).
    */
  readonly fromBodyField: boolean;
}

const ROOT_KINDS = new Set(["program", "module"]);

/**
Named AST fields that represent block-level bodies.
*/
const BODY_FIELDS = new Set(["body", "consequence", "alternative", "handler", "finalizer"]);

/** Identify a child among its siblings; parsers return a new wrapper object on each access. */
function siblingKey(node: SyntaxNode): string {
  const { startPosition: start, endPosition: end } = node;
  return `${node.type}:${start.row}:${start.column}:${end.row}:${end.column}`;
}

let initPromise: Promise<void> | undefined;
const loadedLanguages = new Map<string, Promise<WTS.Language>>();

function grammarWasmPath(extension: string): string | undefined {
  switch (extension) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts": {
      return "tree-sitter-typescript/tree-sitter-typescript.wasm";
    }

    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs": {
      return "tree-sitter-javascript/tree-sitter-javascript.wasm";
    }

    case ".py":
    case ".pyi": {
      return "tree-sitter-python/tree-sitter-python.wasm";
    }

    case ".rs": {
      return "tree-sitter-rust/tree-sitter-rust.wasm";
    }

    case ".c":
    case ".cc":
    case ".hh":
    case ".hxx":
    case ".cpp":
    case ".cxx":
    case ".h":
    case ".hpp": {
      return "tree-sitter-cpp/tree-sitter-cpp.wasm";
    }
    case ".json":
    case ".jsonc": {
      return "tree-sitter-json/tree-sitter-json.wasm";
    }

    case ".yaml":
    case ".yml": {
      return "@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm";
    }

    case ".toml": {
      return "@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm";
    }

    default: {
      return undefined;
    }
  }
}

async function ensureParser(extension: string): Promise<WTS.Parser | undefined> {
  const wasmRelPath = grammarWasmPath(extension);

  if (!wasmRelPath) {
    return undefined;
  }

  initPromise ??= WTS.Parser.init();

  await initPromise;

  let languageLoad = loadedLanguages.get(wasmRelPath);

  if (languageLoad === undefined) {
    const wasmAbsolute = require.resolve(wasmRelPath);
    languageLoad = WTS.Language.load(wasmAbsolute);
    loadedLanguages.set(wasmRelPath, languageLoad);
  }

  const language = await languageLoad;
  const parser = new WTS.Parser();
  parser.setLanguage(language);
  return parser;
}

/**
Parse a document and pass its syntax tree to `use`, then free the tree.

web-tree-sitter trees live in WASM memory that JavaScript GC never reclaims, so the tree and its
nodes are valid only until `use` settles. `use` receives `undefined` when no parser handles the
file or the document is empty.
*/
export async function withParsedDocument<T>(
  filePath: string,
  cwd: string,
  lines: readonly string[],
  use: (tree: SyntaxTree | undefined) => T | Promise<T>,
): Promise<T> {
  const tree = await parseDocument(filePath, cwd, lines);

  try {
    return await use(tree);
  } finally {
    tree?.delete?.();
  }
}

async function parseDocument(
  filePath: string,
  cwd: string,
  lines: readonly string[],
): Promise<SyntaxTree | undefined> {
  if (lines.length === 0) {
    return undefined;
  }

  const absolutePath =
    filePath.includes("://") || path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const source = lines.join("\n");
  const parser = await ensureParser(extension);

  if (parser) {
    try {
      return parser.parse(source) ?? undefined;
    } finally {
      parser.delete();
    }
  }

  return parseNativeDocument(extension, source);
}

class AstScopeTextAnchor extends TextAnchor {
  public constructor(boundary: "begin" | "end", lineAnchor: string, lineNumber: number) {
    super(`scope-${boundary}-${lineAnchor}`, lineNumber);
  }
}

function createScopeAnchor(
  boundary: "begin" | "end",
  lineAnchor: string,
  lineNumber: number,
): TextAnchor {
  return new AstScopeTextAnchor(boundary, lineAnchor, lineNumber);
}

/**
Scope discovery via web-tree-sitter full AST walk.
*/
export class AstScopeManager {
  public async getDocumentScopes(
    filePath: string,
    cwd: string,
    lines: readonly string[],
  ): Promise<ScopeEntry[]> {
    if (lines.length === 0) {
      return [];
    }

    return await withParsedDocument(filePath, cwd, lines, (tree) => {
      if (!tree) {
        return [];
      }

      const candidates: ScopeCandidate[] = [];
      this.collectCandidates(tree.rootNode, candidates);

      return this.buildEntries(candidates, lines);
    });
  }

  private collectCandidates(
    node: SyntaxNode,
    candidates: ScopeCandidate[],
    depth = 0,
    isBodyChild = false,
  ): void {
    if (depth > 100) {
      return;
    }

    if (!node.isNamed) {
      return;
    }

    const nodeType = node.type;

    if (!nodeType || ROOT_KINDS.has(nodeType)) {
      // Root nodes (program, module) — still recurse into children
      for (const child of node.namedChildren) {
        this.collectCandidates(child, candidates, depth + 1);
      }

      return;
    }

    // 1. Collect block bodies from named fields (body, consequence, alternative, etc.)
    // Field children are also named children; step 3 must not walk them again, or every
    // nesting level doubles the traversal and large files freeze the session.
    const visitedFieldChildren = new Set<string>();
    for (const fieldName of BODY_FIELDS) {
      const child = node.childForFieldName(fieldName);

      if (!child?.isNamed) {
        continue;
      }

      visitedFieldChildren.add(siblingKey(child));

      const startLine = child.startPosition.row + 1;
      const endLine = child.endPosition.row + 1;
      const isMultiLine = endLine - startLine >= 3;

      // If the child itself has a body field (e.g. catch_clause → body),
      // skip registering the intermediate node — recurse into it so its
      // inner body gets registered instead.
      const hasOwnBody = [...BODY_FIELDS].some((f) => child.childForFieldName(f) !== null);

      if (isMultiLine && !hasOwnBody) {
        candidates.push({
          startLine,
          endLine,
          kind: `${nodeType}.${fieldName}`,
          fromBodyField: true,
        });
      }

      this.collectCandidates(child, candidates, depth + 1, true);
    }

    // 2. Generic fallback: any named multi-line node with children is a scope,
    //    unless it already has a body field (handled by step 1).
    const hasAnyBodyField = [...BODY_FIELDS].some((f) => node.childForFieldName(f) !== null);

    if (!hasAnyBodyField && !isBodyChild) {
      const nodeStartLine = node.startPosition.row + 1;
      const nodeEndLine = node.endPosition.row + 1;

      if (nodeEndLine - nodeStartLine >= 3 && node.namedChildren.length > 0) {
        candidates.push({
          startLine: nodeStartLine,
          endLine: nodeEndLine,
          kind: nodeType,
          fromBodyField: false,
        });
      }
    }

    // 3. Recurse into the remaining named children (to find nested constructs)
    for (const child of node.namedChildren) {
      if (visitedFieldChildren.has(siblingKey(child))) continue;
      this.collectCandidates(child, candidates, depth + 1);
    }
  }

  private buildEntries(
    candidates: readonly ScopeCandidate[],
    lines: readonly string[],
  ): ScopeEntry[] {
    const byStart = new Map<number, ScopeCandidate>();

    for (const candidate of candidates) {
      const current = byStart.get(candidate.startLine);

      if (
        !current ||
        candidate.endLine > current.endLine ||
        (candidate.endLine === current.endLine && candidate.fromBodyField && !current.fromBodyField)
      ) {
        byStart.set(candidate.startLine, candidate);
      }
    }

    const ordered = [...byStart.values()].sort(
      (a, b) => a.startLine - b.startLine || b.endLine - a.endLine,
    );

    // Filter: nested scopes sharing an endLine with their outer parent are redundant.
    // The outermost scope with a given endLine wins.
    const deduped: ScopeCandidate[] = [];

    for (const candidate of ordered) {
      const hasOuterWithSameEnd = deduped.some(
        (existing) =>
          existing.startLine < candidate.startLine && existing.endLine === candidate.endLine,
      );

      if (!hasOuterWithSameEnd) {
        deduped.push(candidate);
      }
    }

    // A scope is named by the line anchor of its first line, so it keeps its name through edits
    // inside it and moves of other code. No two scopes start on the same line (see byStart).
    const anchors = lineAnchors(lines);

    return deduped.map((candidate) => {
      const firstLineAnchor = anchors[candidate.startLine - 1] ?? "";

      return {
        name: candidate.kind,
        kind: candidate.kind,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        depth: deduped.filter(
          (parent) =>
            parent !== candidate &&
            parent.startLine <= candidate.startLine &&
            parent.endLine >= candidate.endLine &&
            (parent.startLine < candidate.startLine || parent.endLine > candidate.endLine),
        ).length,
        hash: firstLineAnchor,
        blockHash: firstLineAnchor,
        beginAnchor: createScopeAnchor("begin", firstLineAnchor, candidate.startLine),
        endScopeAnchor: createScopeAnchor("end", firstLineAnchor, candidate.endLine),
        scopeBeginAnchor: createScopeAnchor("begin", firstLineAnchor, candidate.startLine),
        scopeEndAnchor: createScopeAnchor("end", firstLineAnchor, candidate.endLine),
      } satisfies ScopeEntry;
    });
  }
}
