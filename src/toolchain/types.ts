/**
 * pi-agent-ide — compile / format / lint pipeline gate.
 *
 * Three independent tool kinds, each with a registry of self-describing
 * implementations. The gate composes them: compile → format → lint.
 *
 * Diagnostic coordinates are 1-based (line/column), matching the
 * VS Code language bridge convention used across lpt.
 */

export type Severity = "error" | "warning" | "info" | "hint";

export interface Diagnostic
{
    code: string;
    message: string;
    /** 1-based line. */
    line: number;
    /** 1-based column. */
    column: number;
    severity: Severity;
}

export interface ToolContext
{
    cwd: string;
}

// ── Formatter ───────────────────────────────────────────────────────

export interface FormatInput
{
    filePath: string;
}

export interface FormatResult
{
    ok: boolean;
    /** Number of edits applied. 0 = no change. */
    edits: number;
}

export interface Formatter
{
    readonly kind: "formatter";
    readonly name: string;
    readonly priority: number;
    /** File extensions this tool handles (lowercased with leading dot, or "*"). */
    readonly extensions: readonly string[];
    /** Returns true if this tool applies to the project (warmup detection). */
    detect(ctx: ToolContext): Promise<boolean>;
    format(input: FormatInput, ctx: ToolContext): Promise<FormatResult>;
}

// ── Compiler ────────────────────────────────────────────────────────

export interface CompileInput
{
    filePath: string;
}

export interface CompileResult
{
    ok: boolean;
    /** All diagnostics from the compiler. */
    diagnostics: Diagnostic[];
    /** Syntax errors (e.g. TS1001-1999) — these trigger rollback in the gate. */
    syntaxErrors: Diagnostic[];
    /** Non-syntax diagnostics — warnings only, never rollback. */
    otherDiagnostics: Diagnostic[];
}

export interface Compiler
{
    readonly kind: "compiler";
    readonly name: string;
    readonly priority: number;
    readonly extensions: readonly string[];
    detect(ctx: ToolContext): Promise<boolean>;
    compile(input: CompileInput, ctx: ToolContext): Promise<CompileResult>;
    restart?(): Promise<void>;
}

// ── Linter ───────────────────────────────────────────────────────────

export interface LintInput
{
    filePath: string;
    /** Request the existing auto-fix command when running the edit gate. */
    fix?: boolean;
}

export interface LintResult
{
    ok: boolean;
    diagnostics: Diagnostic[];
}

export interface Linter
{
    readonly kind: "linter";
    readonly name: string;
    readonly priority: number;
    readonly extensions: readonly string[];
    detect(ctx: ToolContext): Promise<boolean>;
    lint(input: LintInput, ctx: ToolContext): Promise<LintResult>;
}

export type IdeTool = Compiler | Formatter | Linter;

// ── Toolchain & gate result ──────────────────────────────────────────

export interface ActiveToolchain
{
    ctx: ToolContext;
    formatters: readonly Formatter[];
    compilers: readonly Compiler[];
    linters: readonly Linter[];
}

export type GateStage = "compile" | "format" | "lint" | "done";

/** Phase descriptor for gate progress callbacks. */
export interface GatePhaseEntry
{
    /** Phase identifier: "compile" | "lint" | "format" */
    phase: string;
    /** Human-readable tool name, e.g. "TypeScript", "ESLint", "dprint" */
    toolName: string;
    /** Current phase status */
    status: "pending" | "running" | "done";
    /** Duration in ms (only set when status === "done") */
    duration?: number;
}

/**
 * Callback emitted by Gate.runAll for TUI progress updates.
 * First call: all phases sent with status="pending" — UI allocates height immediately.
 * Subsequent calls: individual phase status changes.
 * Always sends the complete array so consumer can replace, not merge.
 */
export type GatePhaseCallback = (phases: GatePhaseEntry[]) => void;

/** Per-file gate result inside a multi-file gate run. */
export interface FileGateResult
{
    filePath: string;
    finalContent: string;
    sourceContent: string;
    compile: CompileResult;
    format: FormatResult;
    lint: LintResult;
}

/** Gate result for multiple files (always array, even for single file). */
export interface GateResult
{
    /** Stage where the gate stopped. "done" = full pipeline ran. */
    stage: GateStage;
    /** True when a compile syntax error means the edit should roll back. */
    rollback: boolean;
    /** Per-file results. Always populated, never empty. */
    files: FileGateResult[];
}
