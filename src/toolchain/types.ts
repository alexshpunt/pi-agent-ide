/** Diagnostic coordinates are 1-based. Formatting stays synchronous; analysis runs separately. */

export type Severity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  code: string;
  message: string;
  /**
    1-based line.
    */
  line: number;
  /**
    1-based column.
    */
  column: number;
  severity: Severity;
}

export interface ToolContext {
  cwd: string;
}

// ── Formatter ───────────────────────────────────────────────────────

export interface FormatInput {
  filePath: string;
}

export interface FormatResult {
  ok: boolean;
  /**
    Number of edits applied. 0 = no change.
    */
  edits: number;
}

export interface Formatter {
  readonly kind: "formatter";
  readonly name: string;
  readonly priority: number;
  /**
    File extensions this tool handles (lowercased with leading dot, or "*").
    */
  readonly extensions: readonly string[];
  /**
    Returns true if this tool applies to the project (warmup detection).
    */
  detect(context: ToolContext): Promise<boolean>;
  format(input: FormatInput, context: ToolContext): Promise<FormatResult>;
}

// ── Compiler ────────────────────────────────────────────────────────

export interface CompileInput {
  filePath: string;
}

export interface CompileResult {
  ok: boolean;
  /**
    All diagnostics from the compiler.
    */
  diagnostics: Diagnostic[];
  /**
    Parser errors from an explicitly syntax-only compiler skip formatting, not the edit.
    */
  syntaxErrors: Diagnostic[];
  /**
    Other diagnostics, including type errors. These do not block formatting.
    */
  otherDiagnostics: Diagnostic[];
}

export interface Compiler {
  /** Opt in only for fast parsing checks without type, project, or LSP analysis. */
  readonly syntaxOnly?: boolean;
  readonly kind: "compiler";
  readonly name: string;
  readonly priority: number;
  readonly extensions: readonly string[];
  detect(context: ToolContext): Promise<boolean>;
  compile(input: CompileInput, context: ToolContext): Promise<CompileResult>;
  restart?(): Promise<void>;
}

// ── Linter ───────────────────────────────────────────────────────────

export interface LintInput {
  filePath: string;
  /**
    Request a configured auto-fix command explicitly. Background diagnostics always use checks.
    */
  fix?: boolean;
}

export interface LintResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export interface Linter {
  readonly kind: "linter";
  readonly name: string;
  readonly priority: number;
  readonly extensions: readonly string[];
  detect(context: ToolContext): Promise<boolean>;
  lint(input: LintInput, context: ToolContext): Promise<LintResult>;
}

export type IdeTool = Compiler | Formatter | Linter;

// ── Toolchain & gate result ──────────────────────────────────────────

export interface ActiveToolchain {
  ctx: ToolContext;
  formatters: readonly Formatter[];
  compilers: readonly Compiler[];
  linters: readonly Linter[];
}
