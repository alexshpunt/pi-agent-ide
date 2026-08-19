export type ChangeState = "partial" | "staged" | "unstaged";

export type ChangeUnavailableReason =
    | "binary"
    | "conflicted"
    | "head-file-lookup-failed"
    | "index-file-lookup-failed"
    | "index-write-failed"
    | "missing-head"
    | "no-worktree"
    | "outside-worktree";

export interface ChangeSegment
{
    readonly headText: string;
    readonly indexText: string;
    readonly worktreeText: string;
    readonly headStart: number;
    readonly headEnd: number;
    readonly indexStart: number;
    readonly indexEnd: number;
    readonly currentStart: number;
    readonly currentEnd: number;
}

export interface ChangeGroup
{
    readonly selector: string;
    readonly digest: string;
    readonly duplicateOrder: number;
    readonly repositoryPath: string;
    readonly state: ChangeState;
    readonly currentStartLine: number;
    readonly currentEndLine: number;
    readonly contextBefore: readonly string[];
    readonly contextAfter: readonly string[];
    readonly canonicalContent: string;
    readonly segments: readonly ChangeSegment[];
}

export type ChangeInspection =
    | {
        readonly status: "applicable";
        readonly head: string;
        readonly repositoryRoot: string;
        readonly repositoryPath: string;
        readonly groups: readonly ChangeGroup[];
    }
    | {
        readonly status: "not-applicable";
        readonly reason: "clean" | "untracked";
    }
    | {
        readonly status: "unavailable";
        readonly reason: ChangeUnavailableReason;
        readonly message: string;
    };

export interface ChangeInspectionInput
{
    readonly source: string;
    readonly worktreeText: string;
    readonly cwd: string;
    readonly signal?: AbortSignal;
}

export type ChangeIndexAction = "stage" | "unstage";

export interface GitIndexUpdate
{
    readonly head: string;
    readonly repositoryPath: string;
    readonly headStart: number;
    readonly headEnd: number;
    readonly replacementText: string;
}

export type ChangeIndexResult =
    | {
        readonly status: "applied" | "unchanged";
        readonly state: "staged" | "unstaged";
        readonly group: ChangeGroup;
    }
    | Exclude<ChangeInspection, { readonly status: "applicable"; }>
    | {
        readonly status: "unavailable";
        readonly reason: "stale-selector";
        readonly message: string;
        readonly availableSelectors: readonly string[];
    };

export type PreparedUndoResult =
    | {
        readonly status: "applied";
        readonly worktreeText: string;
        readonly group: ChangeGroup;
        readonly indexUpdate?: GitIndexUpdate;
    }
    | Exclude<ChangeInspection, { readonly status: "applicable"; }>
    | {
        readonly status: "unavailable";
        readonly reason: "stale-selector";
        readonly message: string;
        readonly availableSelectors: readonly string[];
    };
