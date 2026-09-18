import { createRequire } from "node:module";

import { Lang, parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";

import type { SyntaxNode, SyntaxTree } from "./syntax-tree.js";

interface DynamicLanguagePackage {
  readonly libraryPath: string;
  readonly extensions: string[];
  readonly languageSymbol?: string;
  readonly expandoChar?: string;
}

const require = createRequire(import.meta.url);
const LANGUAGE_PACKAGES = {
  bash: "@ast-grep/lang-bash",
  csharp: "@ast-grep/lang-csharp",
  dart: "@ast-grep/lang-dart",
  elixir: "@ast-grep/lang-elixir",
  go: "@ast-grep/lang-go",
  html: "@ast-grep/lang-html",
  java: "@ast-grep/lang-java",
  kotlin: "@ast-grep/lang-kotlin",
  lua: "@ast-grep/lang-lua",
  markdown: "@ast-grep/lang-markdown",
  php: "@ast-grep/lang-php",
  ruby: "@ast-grep/lang-ruby",
  scala: "@ast-grep/lang-scala",
  sql: "@ast-grep/lang-sql",
  swift: "@ast-grep/lang-swift",
} as const;

export const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ".bash": "bash",
  ".cs": "csharp",
  ".css": Lang.Css,
  ".less": Lang.Css,
  ".scss": Lang.Css,
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".go": "go",
  ".htm": "html",
  ".html": "html",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".lua": "lua",
  ".md": "markdown",
  ".mdx": "markdown",
  ".php": "php",
  ".rb": "ruby",
  ".rake": "ruby",
  ".scala": "scala",
  ".sc": "scala",
  ".sql": "sql",
  ".sh": "bash",
  ".swift": "swift",
};

let registered = false;

function ensureLanguagesRegistered(): void {
  if (registered) return;
  const registrations: Record<string, DynamicLanguagePackage> = {};
  for (const [language, packageName] of Object.entries(LANGUAGE_PACKAGES)) {
    registrations[language] = require(packageName) as DynamicLanguagePackage;
  }
  registerDynamicLanguage(registrations);
  registered = true;
}

export function supportsNativeExtension(extension: string): boolean {
  return extension in EXTENSION_LANGUAGES;
}

export function parseNativeDocument(extension: string, source: string): SyntaxTree | undefined {
  const language = EXTENSION_LANGUAGES[extension];
  if (!language) return undefined;
  ensureLanguagesRegistered();
  return { rootNode: new NativeSyntaxNode(parse(language, source).root(), source) };
}

class NativeSyntaxNode implements SyntaxNode {
  public constructor(
    private readonly node: SgNode,
    private readonly source: string,
  ) {}

  public get type(): string {
    return String(this.node.kind());
  }

  public get text(): string {
    return this.node.text();
  }

  public get isNamed(): boolean {
    return this.node.isNamed();
  }

  public get hasError(): boolean {
    return (
      this.type === "ERROR" ||
      this.node.children().some((child) => new NativeSyntaxNode(child, this.source).hasError)
    );
  }

  public get startIndex(): number {
    return byteOffsetToStringIndex(this.source, this.node.range().start.index);
  }

  public get endIndex(): number {
    return byteOffsetToStringIndex(this.source, this.node.range().end.index);
  }

  public get startPosition(): { row: number; column: number } {
    const { line: row, column } = this.node.range().start;
    return { row, column };
  }

  public get endPosition(): { row: number; column: number } {
    const { line: row, column } = this.node.range().end;
    return { row, column };
  }

  public get parent(): SyntaxNode | null {
    const parent = this.node.parent();
    return parent ? new NativeSyntaxNode(parent, this.source) : null;
  }

  public get namedChildCount(): number {
    return this.namedChildren.length;
  }

  public get namedChildren(): readonly SyntaxNode[] {
    return this.node
      .children()
      .filter((child) => child.isNamed())
      .map((child) => new NativeSyntaxNode(child, this.source));
  }

  public childForFieldName(name: string): SyntaxNode | null {
    const child = this.node.field(name);
    return child ? new NativeSyntaxNode(child, this.source) : null;
  }
}

function byteOffsetToStringIndex(source: string, byteOffset: number): number {
  return Buffer.from(source).subarray(0, byteOffset).toString("utf8").length;
}
