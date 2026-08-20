import { requiredValue } from "../../../../utils/required-value.js";
import path from "node:path";

import {
  formatSourceViewResults,
  renderSourceViewLine,
  type SourceMappedTextContent,
  type SourceViewBlock,
  type SourceViewLine,
} from "pi-agent-ide/api/code-view";

import { collectFiles } from "./collect-files.js";
import { AstScopeManager, parseDocument, type ScopeEntry } from "./manager.js";
import { readTextFile } from "./read-text.js";

import type * as WTS from "web-tree-sitter";

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".c",
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

  public async readFileOutline(filePath: string, cwd: string): Promise<SourceViewBlock> {
    const absolutePath = resolvePath(filePath, cwd);
    const displayPath = path.relative(cwd, absolutePath) || absolutePath;

    if (!isSupportedOutlinePath(absolutePath)) {
      throw new Error(`AST outline is not supported for ${displayPath}.`);
    }

    const snapshot = await readTextFile(absolutePath);
    const tree = await parseDocument(absolutePath, cwd, snapshot.lines);

    if (!tree) {
      throw new Error(`No AST parser is available for ${displayPath}.`);
    }

    return await this.createSourceViewBlock(
      tree.rootNode,
      absolutePath,
      displayPath,
      cwd,
      snapshot.lines,
      snapshot.content,
      path.extname(absolutePath).toLowerCase(),
    );
  }

  public async formatFile(filePath: string, cwd: string): Promise<SourceMappedTextContent> {
    const absolutePath = resolvePath(filePath, cwd);
    const displayPath = path.relative(cwd, absolutePath) || absolutePath;

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

      let tree;

      try {
        tree = await parseDocument(filePath, cwd, snapshot.lines);
      } catch {
        continue;
      }

      if (!tree) {
        continue;
      }

      const match = findSymbol(tree.rootNode, symbol);

      if (!match) {
        continue;
      }

      const displayPath = path.relative(cwd, filePath) || filePath;
      const block = await this.createSourceViewBlock(
        match,
        filePath,
        displayPath,
        cwd,
        snapshot.lines,
        snapshot.content,
        path.extname(filePath).toLowerCase(),
        symbol,
        [`defined in: ${displayPath}:${match.startPosition.row + 1}`],
      );
      return formatSourceViewResults([block], PEEK_FORMAT_OPTIONS);
    }

    return formatSourceViewResults(
      [failedSourceViewBlock("", `symbol not found: ${symbol}`, "PEEK_NOT_FOUND")],
      PEEK_FORMAT_OPTIONS,
    );
  }

  private async createSourceViewBlock(
    node: WTS.Node,
    filePath: string,
    displayPath: string,
    cwd: string,
    sourceLines: readonly string[],
    source: string,
    extension: string,
    heading?: string,
    details?: readonly string[],
  ): Promise<SourceViewBlock> {
    const projectedLines = renderNodeLines(node, source, extension);
    const scopes = await getOutlineScopes(this.fallbackScopeManager, filePath, cwd, sourceLines);
    const markersByLine = buildScopeMarkers(scopes);
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

function getOutlineScopes(
  fallback: AstScopeManager,
  filePath: string,
  cwd: string,
  lines: readonly string[],
): Promise<ScopeEntry[]> {
  return fallback.getDocumentScopes(filePath, cwd, lines);
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
  if (filePath.startsWith("file://")) {
    return decodeURIComponent(filePath.slice("file://".length));
  }

  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function findSymbol(root: WTS.Node, symbol: string): WTS.Node | undefined {
  let result: WTS.Node | undefined;

  const visit = (node: WTS.Node): void => {
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

function getNodeName(node: WTS.Node): string | undefined {
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

function findNestedName(node: WTS.Node): string | undefined {
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

function unwrapDeclaration(node: WTS.Node): WTS.Node {
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

interface MappedCharacter {
  readonly char: string;
  readonly sourceLine?: number;
}

function renderNodeLines(node: WTS.Node, source: string, extension: string): ProjectedLine[] {
  const replacements: Replacement[] = [];

  if (DATA_EXTENSIONS.has(extension)) {
    collectDataReplacements(node, extension, replacements);
  } else {
    collectReplacements(node, extension, replacements);
  }

  const start = lineStartAt(source, node.startIndex);
  const end = lineEndAt(source, node.endIndex);
  const relevant = replacements
    .filter((replacement) => replacement.start >= start && replacement.end <= end)
    .sort((a, b) => b.start - a.start);
  const mapped = mapSourceRange(source, start, end);

  for (const replacement of relevant) {
    const relativeStart = replacement.start - start;
    const relativeEnd = replacement.end - start;
    const inserted = mapReplacement(replacement);
    mapped.splice(relativeStart, relativeEnd - relativeStart, ...inserted);
  }

  while (mapped.length > 0 && /\s/u.test(requiredValue(mapped.at(-1)).char)) {
    mapped.pop();
  }

  const lines: MappedCharacter[][] = [[]];

  for (const item of mapped) {
    if (item.char === "\n") {
      lines.push([]);
    } else {
      requiredValue(lines.at(-1)).push(item);
    }
  }

  return lines.map((line) => {
    const sourceLines = [
      ...new Set(line.flatMap((item) => (item.sourceLine === undefined ? [] : [item.sourceLine]))),
    ];
    return {
      content: line.map((item) => item.char).join(""),
      ...(sourceLines.length === 1 && { sourceLine: sourceLines[0] }),
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

function mapSourceRange(source: string, start: number, end: number): MappedCharacter[] {
  let sourceLine = source.slice(0, start).split("\n").length;
  const mapped: MappedCharacter[] = [];

  for (const char of source.slice(start, end)) {
    mapped.push({ char, sourceLine });

    if (char === "\n") {
      sourceLine += 1;
    }
  }

  return mapped;
}

function mapReplacement(replacement: Replacement): MappedCharacter[] {
  const lineSources = replacement.lineSourceLines ?? [];
  let lineIndex = 0;

  const mapped: MappedCharacter[] = [];

  for (let index = 0; index < replacement.text.length; index += 1) {
    const char = requiredValue(replacement.text[index]);
    const sourceLine = lineSources[lineIndex];
    mapped.push(sourceLine === undefined ? { char } : { char, sourceLine });

    if (char === "\n") {
      lineIndex += 1;
    }
  }

  return mapped;
}

function collectDataReplacements(
  node: WTS.Node,
  extension: string,
  replacements: Replacement[],
): void {
  for (const child of node.namedChildren) {
    if (isDataScalar(child, extension)) {
      if (!isDataKey(child)) {
        replacements.push({
          start: child.startIndex,
          end: child.endIndex,
          text: "…",
          lineSourceLines: [child.startPosition.row + 1],
        });
      }

      continue;
    }

    collectDataReplacements(child, extension, replacements);
  }
}

function isDataScalar(node: WTS.Node, extension: string): boolean {
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

function isDataKey(node: WTS.Node): boolean {
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
  node: WTS.Node,
  extension: string,
  replacements: Replacement[],
  topLevel = false,
): void {
  if (topLevel && !isTopLevelInterfaceNode(node)) {
    replacements.push({
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
      replacements.push({
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
      replacements.push({
        start: value.startIndex,
        end: value.endIndex,
        text: "…",
        lineSourceLines: [value.startPosition.row + 1],
      });
      return;
    }
  }

  for (const child of node.namedChildren) {
    collectReplacements(child, extension, replacements, ROOT_TYPES.has(node.type));
  }
}

function isTopLevelInterfaceNode(node: WTS.Node): boolean {
  return (
    DECLARATION_TYPES.has(node.type) ||
    IMPORT_TYPES.has(node.type) ||
    node.type === "comment" ||
    node.type.startsWith("preproc")
  );
}

function findBody(node: WTS.Node): WTS.Node | undefined {
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

function renderBodyPlaceholder(body: WTS.Node, extension: string): BodyPlaceholder {
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
