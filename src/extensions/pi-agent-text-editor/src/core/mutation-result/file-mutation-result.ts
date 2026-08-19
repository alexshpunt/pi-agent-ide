import type { TextDocument } from "pi-agent-text";

export interface MutationAnchor
{
    readonly lineNumber: number;
    readonly hash?: string;
    readonly value?: string;
    readonly anchor?: string;
}

export interface MutationSnapshot
{
    readonly content: string;
}

export interface AppliedTextChange
{
    readonly editIndex: number;
    readonly fromA: number;
    readonly toA: number;
    readonly fromB: number;
    readonly toB: number;
    readonly removedText: string;
    readonly insertedText: string;
}

interface MutationEdit
{
    readonly range?: FileRange;
}
// ─── Public types ────────────────────────────────────────────────────────

export interface FileChange
{
    path: string;
    action: "edited" | "created" | "overwritten";
    size?: number;
}

export interface FileError
{
    path: string;
    code?: string | undefined;
    reason?: string | undefined;
}

export interface Warning
{
    file?: string;
    messages: string[];
    severity: "diagnostic" | "syntax";
}

export interface DiagnosticHint
{
    file: string;
    line: number;
    column: number;
    anchor?: string;
    lineText?: string;
    severity: "error" | "warning" | "info" | "hint";
    source?: string;
    code: string;
    message: string;
}

export interface SyntaxErrorSummary
{
    total: number;
    shown: number;
}

export interface GatePhase
{
    phase: string;
    toolName: string;
    status: string;
    duration?: number;
}

export interface LintViolation
{
    line: number;
    column: number;
    rule: string;
    message: string;
    category: "in_range" | "out_of_range";
}

/** Structured info about a stale anchor edit. */
export interface StaleEditInfo
{
    index: number;
    expectedAnchor: MutationAnchor;
    failurePoint: "start anchor" | "end anchor";
}

/** A single line in an edit range diagnostic (preview). */
export interface EditDiagnosticLine
{
    lineNumber: number;
    hash: string;
    text: string;
}

/** Detailed stale anchor diagnostic with context. */
export interface StaleAnchorDiagnostic
{
    lineNumber: number;
    expected: { lineNumber: number; hash: string; textAvailable: false; };
    current: EditDiagnosticLine;
    anchorHashChanged: boolean;
    currentContext: EditDiagnosticLine[];
}

export type StrictEditErrorCode =
    | "INVALID_ARGUMENT"
    | "INVALID_PATH"
    | "BINARY_FILE"
    | "INVALID_ANCHOR"
    | "ANCHOR_OUT_OF_RANGE"
    | "STALE_ANCHOR"
    | "INVALID_RANGE"
    | "OVERLAPPING_EDITS"
    | "NO_CHANGE"
    | "WRITE_FAILED"
    | "ROLLBACK_FAILED"
    | "WRITE_OVERWRITE_CONFIRMATION_REQUIRED"
    | "WRITE_OVERWRITE_TARGET_CHANGED"
    | "WRITE_OVERWRITE_CONTENT_CHANGED"
    | "MUTATION_REJECTED"
    | "WRITE_DUPLICATE_TARGET_PATH"
    | "WRITE_ROLLBACK_FAILED"
    | "POST_EDIT_SYNTAX_FAILURE"
    | "INTERNAL_ERROR"
    | "NO_EDITS";

/** Options for constructing a failure result. */
export interface EditFailureOptions
{
    code: StrictEditErrorCode;
    path: string;
    requestedRange?: string;
    failurePoint: string;
    reason: string;
    recovery?: string;
    freshLines?: readonly string[];
    freshCenterLine?: number;
    expectedAnchor?: string;
    currentAnchor?: string;
    proposedDiff?: string;
    internalError?: unknown;
    fileChangedStatement?: string;
    editIndex?: number;
    editIndices?: number[];

    staleDiagnostic?: StaleAnchorDiagnostic;
}

/** Flat data bag for FileMutationResult. All fields optional. */
export interface FileMutationData
{
    // ── Discriminator ──
    kind?: "ok" | "fail" | undefined;
    ok?: boolean | undefined;
    isPartial?: boolean | undefined;

    // ── Result fields ──
    diffs?: string[] | undefined;
    files?: FileChange[] | undefined;
    warnings?: Warning[] | undefined;
    errors?: FileError[] | undefined;
    lintViolations?: LintViolation[] | undefined;
    hints?: DiagnosticHint[] | undefined;
    syntaxErrorSummary?: SyntaxErrorSummary | undefined;
    path?: string | undefined;
    editRange?: FileRange | undefined;
    freshAnchors?: string[] | undefined;

    failurePoint?: string | undefined;
    recovery?: string | undefined;
    expectedAnchor?: string | undefined;
    currentAnchor?: string | undefined;
    internalErrorType?: string | undefined;
    internalErrorMessage?: string | undefined;
    editCount?: number | undefined;
    editRanges?: { startLine: number; endLine: number; }[] | undefined;
    addedLines?: number | undefined;
    removedLines?: number | undefined;
    appliedPaths?: string[] | undefined;
    beforeContentMap?: Record<string, string | null> | undefined;
    skipCount?: number | undefined;
    staleEdits?: StaleEditInfo[] | undefined;
    proposedDiff?: string | undefined;
    editIndex?: number | undefined;
    editIndices?: number[] | undefined;

    staleDiagnostic?: StaleAnchorDiagnostic | undefined;
    fileChangedStatement?: string | undefined;

    // ── Transient engine fields ──
    snapshot?: MutationSnapshot | undefined;
    activeEdits?: MutationEdit[] | undefined;
    inputPath?: string | undefined;
    inputEdits?: unknown[] | undefined;
    afterContent?: string | undefined;
    afterDocument?: TextDocument | undefined;
    /** Scope markers attached to post-edit lines, matching read output. */
    scopeMarkers?: Record<string, string[]> | undefined;
    /** Exact changes produced by the text engine before the post-edit gate. */
    rawChanges?: AppliedTextChange[] | undefined;
    absolutePath?: string | undefined;
    /** Full pre-edit output in the same anchored plain-text shape as read. */
    beforeReadText?: string | undefined;
}

/**
 * Batch-level result from a file-mutation tool execution.
 * Phases are batch-wide (gate runs once for all files), not per-FMR.
 */
export interface FileMutationBatchResult
{
    /** Per-file mutation results (undefined when tool aborted). */
    results: FileMutationResult[] | undefined;
    /** Batch-wide gate phases (undefined = no gate was run). */
    phases?: GatePhase[];
}

/**
 * Edit range — what the user asked for, with parsed line numbers and hashes.
 */
export class FileRange
{
    public readonly start: MutationAnchor;
    public readonly end: MutationAnchor;

    public constructor(start: MutationAnchor, end: MutationAnchor = start)
    {
        if (end.lineNumber < start.lineNumber)
        {
            [start, end] = [end, start];
        }

        this.start = start;
        this.end = end;
    }

    static fromLines(startLine: number, endLine?: number): FileRange
    {
        const end = endLine ?? startLine;
        return new FileRange({ lineNumber: startLine }, { lineNumber: end });
    }
}
// ─── Unified result class ────────────────────────────────────────────────

/**
 * Unified result type for any file-mutating tool operation.
 * Constructed from a flat data bag — never from raw engine types.
 *
 * Consumers access fields via getters (defaults to empty/false).
 */
export class FileMutationResult
{
    readonly data: FileMutationData;

    public constructor(data?: FileMutationData)
    {
        this.data = data ?? {};
    }

    // ── Getters ──

    get ok(): boolean
    {
        return this.data.ok ?? false;
    }
    get isPartial(): boolean
    {
        return this.data.isPartial ?? false;
    }
    get diffs(): string[]
    {
        return this.data.diffs ?? [];
    }
    get files(): FileChange[]
    {
        return this.data.files ?? [];
    }
    get warnings(): Warning[]
    {
        return this.data.warnings ?? [];
    }
    get errors(): FileError[]
    {
        return this.data.errors ?? [];
    }
    get lintViolations(): LintViolation[]
    {
        return this.data.lintViolations ?? [];
    }
    get hints(): DiagnosticHint[]
    {
        return this.data.hints ?? [];
    }

    get syntaxErrorSummary(): SyntaxErrorSummary | undefined
    {
        return this.data.syntaxErrorSummary;
    }
    get path(): string | undefined
    {
        return this.data.path;
    }
    get editRange(): FileRange | undefined
    {
        const edits = this.data.activeEdits;

        if (edits?.length && edits[0]!.range)
        {
            const start = edits[0]!.range.start;
            const lastRange = edits.at(-1)!.range;
            const end = lastRange?.end ?? start;
            return new FileRange(start, end);
        }

        return this.data.editRange;
    }

    get resolvedStartLine(): number | undefined
    {
        return this.editRange?.start.lineNumber;
    }

    get resolvedEndLine(): number | undefined
    {
        return this.editRange?.end.lineNumber;
    }
    get freshAnchors(): string[] | undefined
    {
        return this.data.freshAnchors;
    }

    get failurePoint(): string | undefined
    {
        return this.data.failurePoint;
    }
    get recovery(): string | undefined
    {
        return this.data.recovery;
    }
    get expectedAnchor(): string | undefined
    {
        return this.data.expectedAnchor;
    }
    get currentAnchor(): string | undefined
    {
        return this.data.currentAnchor;
    }
    get internalErrorType(): string | undefined
    {
        return this.data.internalErrorType;
    }
    get internalErrorMessage(): string | undefined
    {
        return this.data.internalErrorMessage;
    }
    get editCount(): number | undefined
    {
        return this.data.editCount;
    }
    get editRanges(): { startLine: number; endLine: number; }[] | undefined
    {
        return this.data.editRanges;
    }
    get addedLines(): number | undefined
    {
        return this.data.addedLines;
    }
    get removedLines(): number | undefined
    {
        return this.data.removedLines;
    }
    get appliedPaths(): string[] | undefined
    {
        return this.data.appliedPaths;
    }
    get beforeContentMap(): Record<string, string | null> | undefined
    {
        return this.data.beforeContentMap;
    }
    get afterContent(): string | undefined
    {
        return this.data.afterContent;
    }
    get skipCount(): number
    {
        return this.data.skipCount ?? 0;
    }
    get staleEdits(): StaleEditInfo[]
    {
        return this.data.staleEdits ?? [];
    }
    get proposedDiff(): string | undefined
    {
        return this.data.proposedDiff;
    }
    get editIndex(): number | undefined
    {
        return this.data.editIndex;
    }
    get editIndices(): number[] | undefined
    {
        return this.data.editIndices;
    }

    get staleDiagnostic(): StaleAnchorDiagnostic | undefined
    {
        return this.data.staleDiagnostic;
    }
    get fileChangedStatement(): string | undefined
    {
        return this.data.fileChangedStatement;
    }

    // ── Computed getters ──

    /** All file paths touched by this mutation (created, edited, overwritten, or failed). */
    get affectedPaths(): string[]
    {
        const set = new Set<string>();

        for (const f of this.files)
        {
            set.add(f.path);
        }

        for (const e of this.errors)
        {
            if (e.path)
            {
                set.add(e.path);
            }
        }

        for (const w of this.warnings)
        {
            if (w.file)
            {
                set.add(w.file);
            }
        }

        return [...set];
    }

    /** True if the mutation was successful AND produced actual changes. */
    get didChange(): boolean
    {
        return this.ok && (this.files.length > 0 || this.diffs.length > 0);
    }

    /** Files that were newly created. */
    get createdFiles(): FileChange[]
    {
        return this.files.filter((f) => f.action === "created");
    }

    /** Files that were overwritten (write) or edited in-place (strict). */
    get overwrittenFiles(): FileChange[]
    {
        return this.files.filter((f) => f.action === "overwritten" || f.action === "edited");
    }

    /** Number of stale anchor edits (derived from staleEdits). */
    get staleCount(): number
    {
        return this.staleEdits.length;
    }

    /**
     * Short human-readable summary.
     *
     * Examples:
     *   "3 files changed, +45/-12 lines"
     *   "Created 2 files"
     *   "Failed: STALE_ANCHOR — anchor hash mismatch"
     */
    get summary(): string
    {
        if (!this.ok)
        {
            const first = this.errors[0];

            if (first)
            {
                return `Failed: ${first.code ?? "ERROR"}${first.reason ? ` — ${first.reason}` : ""}`;
            }

            return "Mutation failed";
        }

        if (this.files.length === 0 && this.diffs.length === 0)
        {
            const paths = this.appliedPaths;

            if (paths && paths.length > 0)
            {
                return `${paths.length} path${paths.length === 1 ? "" : "s"} affected`;
            }

            return "No changes";
        }

        const created = this.createdFiles.length;
        const edited = this.overwrittenFiles.length;
        const parts: string[] = [];

        if (created > 0)
        {
            parts.push(`Created ${created} ${created === 1 ? "file" : "files"}`);
        }

        if (edited > 0)
        {
            parts.push(`Edited ${edited} ${edited === 1 ? "file" : "files"}`);
        }

        // Count total +/- from diffs if available
        if (this.diffs.length > 0)
        {
            let added = 0;
            let removed = 0;

            for (const diff of this.diffs)
            {
                for (const line of diff.split("\n"))
                {
                    if (line.startsWith("+") && !line.startsWith("+++"))
                    {
                        added++;
                    }
                    else if (line.startsWith("-") && !line.startsWith("---"))
                    {
                        removed++;
                    }
                }
            }

            if (added > 0 || removed > 0)
            {
                parts.push(`+${added}/-${removed} lines`);
            }
        }

        return parts.join(", ");
    }

    // ── Methods ──

    /** Find the FileChange entry for a specific path, if any. */
    getFileChange(path: string): FileChange | undefined
    {
        return this.files.find((f) => f.path === path);
    }

    /** Extract the unified diff for a specific file path, if present. */
    getDiffFor(path: string): string | undefined
    {
        const normalised = normalisePath(path);

        for (const diff of this.diffs)
        {
            const match = diff.match(/^---\s+(.+)$/m);

            if (match && (normalisePath(match[1]!) === normalised || match[1] === path))
            {
                return diff;
            }
        }

        return undefined;
    }

    /** All errors that relate to a specific path. */
    getErrorsFor(path: string): FileError[]
    {
        return this.errors.filter((e) => e.path === path);
    }

    /** All warnings that relate to a specific path. */
    getWarningsFor(path: string): Warning[]
    {
        return this.warnings.filter((w) => w.file === path);
    }
    /** Create a FileMutationResult from a KnownEditFailure options. */
    static fromFailureOptions(opts: EditFailureOptions): FileMutationResult
    {
        return new FileMutationResult({
            ok: false,
            path: opts.path,
            errors: [{ path: opts.path, code: opts.code, reason: opts.reason }],
            failurePoint: opts.failurePoint,
            recovery: opts.recovery,
            expectedAnchor: opts.expectedAnchor,
            currentAnchor: opts.currentAnchor,
            freshAnchors: opts.freshLines ? [...opts.freshLines] : undefined,
            internalErrorType: opts.internalError instanceof Error ? opts.internalError.name : undefined,
            internalErrorMessage: opts.internalError instanceof Error ? opts.internalError.message : undefined,
        });
    }

    /**
     * Ensures a value is a proper FileMutationResult instance.
     * JSON.parse strips the prototype, making getters (createdFiles, diffs, etc.)
     * inaccessible. This restores the instance without copying data.
     */
    static ensure(value: unknown): FileMutationResult
    {
        if (value instanceof FileMutationResult)
        {
            return value;
        }

        if (value && typeof value === "object")
        {
            const obj = value as Record<string, unknown>;

            // After JSON.parse: { data: { ok, files, ... } }
            if (obj.data && typeof obj.data === "object")
            {
                Object.setPrototypeOf(obj, FileMutationResult.prototype);
                return obj as unknown as FileMutationResult;
            }

            // Raw FileMutationData — construct fresh
            return new FileMutationResult(obj);
        }

        return new FileMutationResult();
    }
}

// ─── Module-level helpers ────────────────────────────────────────────────

function normalisePath(p: string): string
{
    return p.replace(/\\/g, "/").replace(/^a\//, "").replace(/^b\//, "");
}
