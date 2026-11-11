import { requiredValue } from "pi-agent-invariant";
import { lineAnchors } from "pi-agent-text";
import path from "node:path";

import {
  formatSourceViewResults,
  renderSourceViewLine,
  type SourceMappedTextContent,
  type SourceViewBlock,
  type SourceViewLine,
} from "pi-agent-ide/api/code-view";

import { collectFiles } from "./collect-files.ts";
import { AstScopeManager, withParsedDocument, type ScopeEntry } from "./manager.ts";
import { EXTENSION_LANGUAGES } from "./native-parser.ts";
import { readTextFile } from "./read-text.ts";

import type { SyntaxNode } from "./syntax-tree.ts";

const SUPPORTED_EXTENSIONS = new Set([
  ...Object.keys(EXTENSION_LANGUAGES),
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".rs",
  ".c",
  ".cc",
  ".hh",
  ".hxx",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
]);

const DATA_EXTENSIONS = new Set([".json", ".jsonc", ".yaml", ".yml", ".toml"]);

const DECLARATION_TYPES = new Set([
  "class_declaration",
  "class_definition",
  "class_specifier",
  "enum_declaration",
  "enum_definition",
  "enum_item",
  "enum_specifier",
  "export_statement",
  "function_declaration",
  "function_definition",
  "function_item",
  "impl_item",
  "interface_declaration",
  "lexical_declaration",
  "namespace_definition",
  "mod_item",
  "public_field_definition",
  "method_definition",
  "method_signature",
  "property_signature",
  "field_declaration",
  "struct_item",
  "struct_specifier",
  "trait_item",
  "type_alias_declaration",
  "type_item",
  "variable_declaration",
  "assignment",
]);

const ROOT_TYPES = new Set(["module", "program", "source_file"]);

const IMPORT_TYPES = new Set([
  "import_declaration",
  "import_from_statement",
  "import_statement",
  "use_declaration",
]);

const FUNCTION_TYPES = new Set([
  "arrow_function",
  "function_declaration",
  "function_definition",
  "function_item",
  "function_expression",
  "method_definition",
]);

const INITIALIZER_TYPES = new Set(["public_field_definition", "variable_declarator", "assignment"]);

const NAME_TYPES = new Set([
  "field_identifier",
  "identifier",
  "property_identifier",
  "shorthand_property_identifier_pattern",
  "type_identifier",
]);

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly lineSourceLines?: readonly (number | undefined)[];
}

interface ProjectedLine {
  readonly content: string;
  readonly sourceLine?: number;
}

interface SourceViewContext {
  readonly markersByLine: ReadonlyMap<number, readonly string[]>;
  readonly anchors: readonly string[];
}

export function isSupportedOutlinePath(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

const PEEK_FORMAT_OPTIONS = {
  failureLabel: "PEEK_FAILED",
  emptyReason: "no entries to peek.",
  recovery: ['Call peek with { peers: [{ path: "path/to/file.ts" }, ...] }.'],
} as const;

const AST_OUTLINE_FORMAT_OPTIONS = {
  failureLabel: "AST_OUTLINE_FAILED",
  emptyReason: "no AST outline was produced.",
} as const;

export function formatAstOutline(block: SourceViewBlock): SourceMappedTextContent {
  return formatSourceViewResults([block], AST_OUTLINE_FORMAT_OPTIONS);
}

export class AstOutlineManager {
  private readonly fallbackScopeManager = new AstScopeManager();

  /** Limit syntax-tree nesting for automatic overviews; explicit outlines keep their existing depth. */
  public constructor(private readonly maxDepth = Number.POSITIVE_INFINITY) {}

  public async readFileOutline(filePath: string, cwd: string): Promise<SourceViewBlock> {
    const absolutePath = resolvePath(filePath, cwd);
    const displayPath = absolutePath.includes("://")
      ? absolutePath
      : path.relative(cwd, absolutePath) || absolutePath;

    if (!isSupportedOutlinePath(absolutePath)) {
      throw new Error(`AST outline is not supported for ${displayPath}.`);
    }

    const snapshot = await readTextFile(absolutePath);
    return this.readDocumentOutline(absolutePath, cwd, snapshot.lines);
  }

  /** Build an outline from the read snapshot. With a finite depth and a budget
   * predicate, reduce nesting until it fits or reaches file-only detail. Parse once.
   */
  public async readDocumentOutline(
    filePath: string,
    cwd: string,
    lines: readonly string[],
    fits?: (outline: SourceViewBlock) => boolean,
  ): Promise<SourceViewBlock> {
    const absolutePath = resolvePath(filePath, cwd);
    const displayPath = absolutePath.includes("://")
      ? absolutePath
      : path.relative(cwd, absolutePath) || absolutePath;
    if (!isSupportedOutlinePath(absolutePath)) {
      throw new Error(`AST outline is not supported for ${displayPath}.`);
    }
    return await withParsedDocument(absolutePath, cwd, lines, async (tree) => {
      if (!tree) {
        throw new Error(`No AST parser is available for ${displayPath}.`);
      }
      if (Number.isFinite(this.maxDepth) && tree.rootNode.hasError) {
        throw new Error(`Cannot build an automatic outline from invalid syntax in ${displayPath}.`);
      }

      const content = lines.join("\n");
      const extension = path.extname(absolutePath).toLowerCase();
      // Walk the syntax tree and its scopes once; each depth candidate only selects replacements.
      const staged = stageReplacements(tree.rootNode, extension, this.maxDepth);
      const stagedDepths = new Set(staged.map((item) => item.depth));
      const view = this.prepareSourceView(tree.rootNode, lines);
      let outline: SourceViewBlock | undefined;
      for (let depth = this.maxDepth; ; depth -= 1) {
        // The selection changes only through items at this depth or one level deeper.
        // Otherwise the candidate would render the previous outline again.
        if (outline === undefined || stagedDepths.has(depth) || stagedDepths.has(depth + 1)) {
          outline = this.createSourceViewBlock(
            tree.rootNode,
            absolutePath,
            displayPath,
            lines,
            content,
            selectReplacements(staged, depth),
            view,
          );
          if (fits === undefined || fits(outline)) return outline;
        }
        if (depth <= 0 || !Number.isFinite(depth)) return outline;
      }
    });
  }

  public async formatFile(filePath: string, cwd: string): Promise<SourceMappedTextContent> {
    const absolutePath = resolvePath(filePath, cwd);
    const displayPath = absolutePath.includes("://")
      ? absolutePath
      : path.relative(cwd, absolutePath) || absolutePath;

    if (!isSupportedOutlinePath(absolutePath)) {
      const snapshot = await readTextFile(absolutePath);
      return formatSourceViewResults(
        [formatUnsupportedSourceBlock(absolutePath, displayPath, snapshot.lines)],
        PEEK_FORMAT_OPTIONS,
      );
    }

    try {
      return formatSourceViewResults(
        [await this.readFileOutline(absolutePath, cwd)],
        PEEK_FORMAT_OPTIONS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return formatSourceViewResults(
        [failedSourceViewBlock(displayPath, message)],
        PEEK_FORMAT_OPTIONS,
      );
    }
  }

  public async formatSymbol(symbol: string, cwd: string): Promise<SourceMappedTextContent> {
    const files = await collectFiles(cwd);
    const supportedFiles = files.filter((filePath) => isSupportedOutlinePath(filePath)).sort();

    for (const filePath of supportedFiles) {
      let snapshot;

      try {
        snapshot = await readTextFile(filePath);
      } catch {
        continue;
      }

      let block: SourceViewBlock | undefined;
      const progress = { parsed: false };

      try {
        block = await withParsedDocument(filePath, cwd, snapshot.lines, async (tree) => {
          progress.parsed = true;
          const match = tree && findSymbol(tree.rootNode, symbol);

          if (!match) {
            return undefined;
          }

          const displayPath = path.relative(cwd, filePath) || filePath;
          return this.createSourceViewBlock(
            match,
            filePath,
            displayPath,
            snapshot.lines,
            snapshot.content,
            selectReplacements(
              stageReplacements(match, path.extname(filePath).toLowerCase(), this.maxDepth),
              this.maxDepth,
            ),
            this.prepareSourceView(tree.rootNode, snapshot.lines),
            symbol,
            [`defined in: ${displayPath}:${match.startPosition.row + 1}`],
          );
        });
      } catch (error) {
        // Skip files that fail to parse; rendering errors still surface.
        if (progress.parsed) {
          throw error;
        }
        continue;
      }

      if (block) {
        return formatSourceViewResults([block], PEEK_FORMAT_OPTIONS);
      }
    }

    return formatSourceViewResults(
      [failedSourceViewBlock("", `symbol not found: ${symbol}`, "PEEK_NOT_FOUND")],
      PEEK_FORMAT_OPTIONS,
    );
  }

  /** Scope markers and line anchors depend only on the parsed document, not on the outline depth. */
  private prepareSourceView(root: SyntaxNode, sourceLines: readonly string[]): SourceViewContext {
    const anchors = lineAnchors(sourceLines);
    return {
      markersByLine: buildScopeMarkers(this.fallbackScopeManager.getTreeScopes(root, anchors)),
      anchors,
    };
  }

  private createSourceViewBlock(
    node: SyntaxNode,
    filePath: string,
    displayPath: string,
    sourceLines: readonly string[],
    source: string,
    replacements: readonly Replacement[],
    { markersByLine, anchors }: SourceViewContext,
    heading?: string,
    details?: readonly string[],
  ): SourceViewBlock {
    const projectedLines = renderNodeLines(node, source, replacements);
    const renderedLines = projectedLines.map((line) => {
      const sourceLineNumber = line.sourceLine;
      const sourceContent =
        sourceLineNumber === undefined ? undefined : (sourceLines[sourceLineNumber - 1] ?? "");
      const markers =
        sourceLineNumber === undefined ? undefined : markersByLine.get(sourceLineNumber);
      const suffix = markers?.map((marker) => `  <!-- ${marker} -->`).join("") ?? "";

      return renderSourceViewLine({
        content: line.content,
        ...(!(sourceLineNumber === undefined || sourceContent === undefined) && {
          sourceLine: {
            source: filePath,
            lineNumber: sourceLineNumber,
            content: sourceContent,
            ...(anchors[sourceLineNumber - 1] !== undefined && {
              anchor: anchors[sourceLineNumber - 1],
            }),
          },
        }),
        ...(suffix.length > 0 && { suffix }),
      } satisfies SourceViewLine);
    });

    return {
      path: displayPath,
      ...(heading !== undefined && { heading }),
      ...(details !== undefined && { details }),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      totalLines: sourceLines.length,
      renderedLines,
    };
  }
}

function formatUnsupportedSourceBlock(
  sourcePath: string,
  displayPath: string,
  sourceLines: readonly string[],
): SourceViewBlock {
  const anchors = lineAnchors(sourceLines);
  return {
    path: displayPath,
    startLine: sourceLines.length > 0 ? 1 : 0,
    endLine: sourceLines.length,
    totalLines: sourceLines.length,
    renderedLines: sourceLines.map((content, index) =>
      renderSourceViewLine({
        content,
        sourceLine: {
          source: sourcePath,
          lineNumber: index + 1,
          content,
          anchor: requiredValue(anchors[index]),
        },
      }),
    ),
  };
}

function failedSourceViewBlock(path: string, error: string, code = "PEEK_FAILED"): SourceViewBlock {
  return {
    path,
    startLine: 0,
    endLine: 0,
    totalLines: 0,
    renderedLines: [],
    status: "failed",
    error,
    code,
  };
}

function buildScopeMarkers(scopes: readonly ScopeEntry[]): Map<number, string[]> {
  const markers = new Map<number, string[]>();

  for (const scope of scopes) {
    const begin = markers.get(scope.startLine) ?? [];
    begin.push(scope.beginAnchor.value);
    markers.set(scope.startLine, begin);

    const end = markers.get(scope.endLine) ?? [];
    end.push(scope.endScopeAnchor.value);
    markers.set(scope.endLine, end);
  }

  return markers;
}

function resolvePath(filePath: string, cwd: string): string {
  if (filePath.startsWith("ssh://")) return filePath;
  if (filePath.startsWith("file://")) {
    return decodeURIComponent(filePath.slice("file://".length));
  }

  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function findSymbol(root: SyntaxNode, symbol: string): SyntaxNode | undefined {
  let result: SyntaxNode | undefined;

  const visit = (node: SyntaxNode): void => {
    if (result) {
      return;
    }

    if (DECLARATION_TYPES.has(node.type) && getNodeName(node) === symbol) {
      result = unwrapDeclaration(node);
      return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  };

  visit(root);
  return result;
}

function getNodeName(node: SyntaxNode): string | undefined {
  const nameField = node.childForFieldName("name");

  if (nameField && NAME_TYPES.has(nameField.type)) {
    return nameField.text;
  }

  for (const child of node.namedChildren) {
    if (NAME_TYPES.has(child.type)) {
      return child.text;
    }
  }

  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const declarator = node.namedChildren.find((child) => child.type === "variable_declarator");
    const name = declarator?.childForFieldName("name");
    return name?.text;
  }

  if (node.type === "function_definition") {
    const declarator = node.childForFieldName("declarator");
    return declarator ? findNestedName(declarator) : undefined;
  }

  return undefined;
}

function findNestedName(node: SyntaxNode): string | undefined {
  if (NAME_TYPES.has(node.type)) {
    return node.text;
  }

  for (const child of node.namedChildren) {
    const name = findNestedName(child);

    if (name) {
      return name;
    }
  }

  return undefined;
}

function unwrapDeclaration(node: SyntaxNode): SyntaxNode {
  const parent = node.parent;

  if (
    parent &&
    (parent.type === "export_statement" ||
      parent.type === "decorated_definition" ||
      parent.type === "template_declaration")
  ) {
    return parent;
  }

  return node;
}

/** Text without line breaks from one source line, or from no source line. */
interface LinePiece {
  readonly text: string;
  readonly sourceLine?: number;
}

/** Project a node's source lines with the replacements applied. A projected line maps to a source
 * line when all its text comes from that one line. A replacement that overlaps an applied one is
 * skipped. Tree-sitter offsets use UTF-16 code units, just like String indexing.
 */
function renderNodeLines(
  node: SyntaxNode,
  source: string,
  replacements: readonly Replacement[],
): ProjectedLine[] {
  const start = lineStartAt(source, node.startIndex);
  const end = lineEndAt(source, node.endIndex);
  const relevant = replacements
    .filter((replacement) => replacement.start >= start && replacement.end <= end)
    .sort((a, b) => a.start - b.start);
  const lines: LinePiece[][] = [[]];
  const appendText = (text: string, sourceLineAt: (lineIndex: number) => number | undefined) => {
    let lineIndex = 0;
    for (let from = 0; ; lineIndex += 1) {
      const newline = text.indexOf("\n", from);
      const piece = text.slice(from, newline === -1 ? text.length : newline);
      const sourceLine = sourceLineAt(lineIndex);
      if (piece.length > 0) {
        requiredValue(lines.at(-1)).push(
          sourceLine === undefined ? { text: piece } : { text: piece, sourceLine },
        );
      }
      if (newline === -1) return lineIndex;
      lines.push([]);
      from = newline + 1;
    }
  };

  let sourceLine = countLines(source, 0, start);
  let cursor = start;
  const appendSource = (to: number) => {
    const firstLine = sourceLine;
    sourceLine += appendText(source.slice(cursor, to), (lineIndex) => firstLine + lineIndex);
    cursor = to;
  };
  for (const replacement of relevant) {
    if (replacement.start < cursor) continue;
    appendSource(replacement.start);
    const lineSources = replacement.lineSourceLines ?? [];
    appendText(replacement.text, (lineIndex) => lineSources[lineIndex]);
    sourceLine += countLines(source, replacement.start, replacement.end) - 1;
    cursor = replacement.end;
  }
  appendSource(end);

  trimTrailingWhitespace(lines);
  return lines.map((pieces) => {
    const sourceLines = new Set(pieces.flatMap((piece) => piece.sourceLine ?? []));
    return {
      content: pieces.map((piece) => piece.text).join(""),
      ...(sourceLines.size === 1 && { sourceLine: requiredValue([...sourceLines][0]) }),
    };
  });
}

function lineStartAt(source: string, index: number): number {
  const newline = source.lastIndexOf("\n", Math.max(0, index - 1));
  return newline + 1;
}

function lineEndAt(source: string, index: number): number {
  const newline = source.indexOf("\n", index);
  return newline === -1 ? source.length : newline;
}

/** One plus the number of line breaks in `source` between `start` and `end`. */
function countLines(source: string, start: number, end: number): number {
  let count = 1;
  for (let index = source.indexOf("\n", start); index !== -1 && index < end;) {
    count += 1;
    index = source.indexOf("\n", index + 1);
  }
  return count;
}

/** Remove trailing whitespace, including line breaks, from the projected text. */
function trimTrailingWhitespace(lines: LinePiece[][]): void {
  for (;;) {
    const pieces = requiredValue(lines.at(-1));
    const last = pieces.at(-1);
    if (last === undefined) {
      if (lines.length === 1) return;
      lines.pop();
      continue;
    }
    const text = last.text.trimEnd();
    if (text.length === last.text.length) return;
    pieces.pop();
    if (text.length > 0) {
      pieces.push({ ...last, text });
      return;
    }
  }
}

/** A replacement found by one tree walk, tagged so that each depth limit can select its own set. */
interface StagedReplacement {
  readonly replacement: Replacement;
  /** Depth of the visited node that produced the replacement. */
  readonly depth: number;
  /** The node itself collapses into "…" when the depth limit equals its depth. */
  readonly collapse: boolean;
  /** The visited node has no named children, so a depth limit never collapses it. */
  readonly leaf: boolean;
}

/** Walk the tree once up to `maxDepth`. For any limit at or below it, selectReplacements returns
 * what a separate walk limited to that depth would produce.
 */
function stageReplacements(
  node: SyntaxNode,
  extension: string,
  maxDepth: number,
): StagedReplacement[] {
  const staged: StagedReplacement[] = [];
  if (DATA_EXTENSIONS.has(extension)) {
    collectDataReplacements(node, extension, staged, maxDepth);
  } else {
    collectReplacements(node, extension, staged, false, maxDepth);
  }
  return staged;
}

/** A walk limited to `maxDepth` collapses each node with children at that depth and stops there.
 * It keeps the other replacements of nodes above that depth and of childless nodes at it.
 */
function selectReplacements(staged: readonly StagedReplacement[], maxDepth: number): Replacement[] {
  return staged
    .filter(({ depth, collapse, leaf }) =>
      collapse ? depth === maxDepth : depth < maxDepth || (depth === maxDepth && leaf),
    )
    .map(({ replacement }) => replacement);
}

/** Stage the collapse of a node with children; return true when the walk stops at it. */
function stageCollapse(
  node: SyntaxNode,
  leaf: boolean,
  staged: StagedReplacement[],
  depth: number,
  maxDepth: number,
): boolean {
  if (leaf || !Number.isFinite(maxDepth)) return false;
  staged.push({
    replacement: {
      start: node.startIndex,
      end: node.endIndex,
      text: "…",
      lineSourceLines: [node.startPosition.row + 1],
    },
    depth,
    collapse: true,
    leaf,
  });
  return depth >= maxDepth;
}

function collectDataReplacements(
  node: SyntaxNode,
  extension: string,
  staged: StagedReplacement[],
  maxDepth: number,
  depth = 0,
): void {
  const leaf = node.namedChildCount === 0;
  if (stageCollapse(node, leaf, staged, depth, maxDepth)) return;
  for (const child of node.namedChildren) {
    if (isDataScalar(child, extension)) {
      if (!isDataKey(child)) {
        staged.push({
          replacement: {
            start: child.startIndex,
            end: child.endIndex,
            text: "…",
            lineSourceLines: [child.startPosition.row + 1],
          },
          depth,
          collapse: false,
          leaf,
        });
      }

      continue;
    }

    collectDataReplacements(child, extension, staged, maxDepth, depth + 1);
  }
}

function isDataScalar(node: SyntaxNode, extension: string): boolean {
  const scalarTypes =
    extension === ".json" || extension === ".jsonc"
      ? ["string", "number", "true", "false", "null"]
      : extension === ".yaml" || extension === ".yml"
        ? [
            "string_scalar",
            "integer_scalar",
            "float_scalar",
            "boolean_scalar",
            "null_scalar",
            "block_scalar",
          ]
        : [
            "string",
            "integer",
            "float",
            "boolean",
            "date_time",
            "offset_date_time",
            "local_date_time",
            "local_date",
            "local_time",
          ];

  return scalarTypes.includes(node.type);
}

function isDataKey(node: SyntaxNode): boolean {
  let ancestor = node.parent;

  while (
    ancestor &&
    !ancestor.type.endsWith("pair") &&
    ancestor.type !== "pair" &&
    ancestor.type !== "table"
  ) {
    ancestor = ancestor.parent;
  }

  const key = ancestor?.namedChildren[0];
  return key !== undefined && key.startIndex <= node.startIndex && key.endIndex >= node.endIndex;
}

function collectReplacements(
  node: SyntaxNode,
  extension: string,
  staged: StagedReplacement[],
  topLevel: boolean,
  maxDepth: number,
  depth = 0,
): void {
  const leaf = node.namedChildCount === 0;
  if (stageCollapse(node, leaf, staged, depth, maxDepth)) return;
  const stage = (replacement: Replacement): void => {
    staged.push({ replacement, depth, collapse: false, leaf });
  };
  const keepCall = Number.isFinite(maxDepth) && node.type === "expression_statement";
  if (topLevel && !isTopLevelInterfaceNode(node) && !keepCall) {
    stage({
      start: node.startIndex,
      end: node.endIndex,
      text: "…",
      lineSourceLines: [node.startPosition.row + 1],
    });
    return;
  }

  if (FUNCTION_TYPES.has(node.type)) {
    const body = findBody(node);

    if (body) {
      const placeholder = renderBodyPlaceholder(body, extension);
      stage({
        start: body.startIndex,
        end: body.endIndex,
        text: placeholder.text,
        lineSourceLines: placeholder.lineSourceLines,
      });
      return;
    }
  }

  if (INITIALIZER_TYPES.has(node.type)) {
    const value = node.childForFieldName("value");

    if (value && !FUNCTION_TYPES.has(value.type)) {
      stage({
        start: value.startIndex,
        end: value.endIndex,
        text: "…",
        lineSourceLines: [value.startPosition.row + 1],
      });
      return;
    }
  }

  for (const child of node.namedChildren) {
    collectReplacements(child, extension, staged, ROOT_TYPES.has(node.type), maxDepth, depth + 1);
  }
}

function isTopLevelInterfaceNode(node: SyntaxNode): boolean {
  return (
    DECLARATION_TYPES.has(node.type) ||
    IMPORT_TYPES.has(node.type) ||
    node.type === "comment" ||
    node.type.startsWith("preproc")
  );
}

function findBody(node: SyntaxNode): SyntaxNode | undefined {
  const fieldBody = node.childForFieldName("body");

  if (fieldBody) {
    return fieldBody;
  }

  return node.namedChildren.find(
    (child) =>
      child.type === "block" ||
      child.type === "compound_statement" ||
      child.type === "statement_block",
  );
}

interface BodyPlaceholder {
  readonly text: string;
  readonly lineSourceLines: readonly (number | undefined)[];
}

function renderBodyPlaceholder(body: SyntaxNode, extension: string): BodyPlaceholder {
  const startLine = body.startPosition.row + 1;
  const endLine = body.endPosition.row + 1;

  if (extension === ".py") {
    return { text: "...", lineSourceLines: [startLine] };
  }

  const bodyLines = body.text.split("\n");
  const firstLine = bodyLines[0] ?? "";
  const lastLine = bodyLines.at(-1) ?? "";
  const openIndex = firstLine.indexOf("{");
  const closeIndex = lastLine.lastIndexOf("}");

  if (openIndex === -1 || closeIndex === -1) {
    return { text: "…", lineSourceLines: [startLine] };
  }

  if (bodyLines.length === 1) {
    const inner = firstLine.slice(openIndex + 1, closeIndex);

    if (inner.trim() === "") {
      return { text: body.text, lineSourceLines: [startLine] };
    }

    return {
      text: firstLine.slice(0, openIndex + 1) + maskSegment(inner) + firstLine.slice(closeIndex),
      lineSourceLines: [startLine],
    };
  }

  const afterOpen = firstLine.slice(openIndex + 1);
  const beforeClose = lastLine.slice(0, closeIndex);
  const isInteriorHasContent = bodyLines.slice(1, -1).some((line) => line.trim() !== "");
  const isFirstHasContent = afterOpen.trim() !== "";
  const isLastHasContent = beforeClose.trim() !== "";

  if (!isInteriorHasContent && !isFirstHasContent && !isLastHasContent) {
    return {
      text: body.text,
      lineSourceLines: bodyLines.map((_, index) => startLine + index),
    };
  }

  const output: string[] = [];
  const lineSourceLines: (number | undefined)[] = [];
  output.push(
    isFirstHasContent ? firstLine.slice(0, openIndex + 1) + maskSegment(afterOpen) : firstLine,
  );
  lineSourceLines.push(startLine);

  if (!isFirstHasContent && isInteriorHasContent) {
    const indentation =
      bodyLines
        .slice(1, -1)
        .find((line) => line.trim() !== "")
        ?.match(/^\s*/u)?.[0] ?? "";
    output.push(`${indentation}…`);
    lineSourceLines.push(undefined);
  }

  output.push(isLastHasContent ? maskSegment(beforeClose) + lastLine.slice(closeIndex) : lastLine);
  lineSourceLines.push(endLine);

  return { text: output.join("\n"), lineSourceLines };
}

function maskSegment(segment: string): string {
  const leading = /^\s*/u.exec(segment)?.[0] ?? "";
  const trailing = /\s*$/u.exec(segment)?.[0] ?? "";
  return `${leading}…${trailing}`;
}
