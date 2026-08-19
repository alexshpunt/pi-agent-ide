import { createChangeGroups, replaceHeadRangeInIndex, reverseChangeGroup } from "./change-groups.js";
import { GitChangesBackend } from "./git-changes-backend.js";

import type {
    ChangeIndexAction,
    ChangeIndexResult,
    ChangeInspection,
    ChangeInspectionInput,
    GitIndexUpdate,
    PreparedUndoResult,
} from "./change-types.js";
import type { GitCommandExecutor } from "./git-changes-backend.js";

export type ChangeServiceCreation =
    | { readonly status: "ready"; readonly service: ChangeService; }
    | { readonly status: "unavailable"; readonly reason: "no-worktree"; readonly message: string; };

export class ChangeService
{
    static async create(
        executor: GitCommandExecutor,
        cwd: string,
        signal?: AbortSignal,
    ): Promise<ChangeServiceCreation>
    {
        const creation = await GitChangesBackend.create(executor, cwd, signal);

        if (creation.status === "unavailable")
        {
            return creation;
        }

        return { status: "ready", service: new ChangeService(creation.backend) };
    }

    private constructor(private readonly git: GitChangesBackend)
    {}

    async inspect(input: ChangeInspectionInput): Promise<ChangeInspection>
    {
        if (input.worktreeText.includes("\0"))
        {
            return { status: "unavailable", reason: "binary", message: "worktree file contains binary content" };
        }

        const versions = await this.git.readTrackedFile(input.source, input.cwd, input.signal);

        if (versions.status !== "found")
        {
            return versions.status === "untracked"
                ? { status: "not-applicable", reason: "untracked" }
                : versions;
        }

        if (versions.headText.includes("\0") || versions.indexText.includes("\0"))
        {
            return { status: "unavailable", reason: "binary", message: "Git file state contains binary content" };
        }

        const groups = createChangeGroups(
            versions.repositoryPath,
            versions.headText,
            versions.indexText,
            input.worktreeText,
        );

        if (groups.length === 0)
        {
            return { status: "not-applicable", reason: "clean" };
        }

        return {
            status: "applicable",
            head: versions.head,
            repositoryRoot: versions.repositoryRoot,
            repositoryPath: versions.repositoryPath,
            groups,
        };
    }

    async changeIndex(
        input: ChangeInspectionInput,
        selector: string,
        action: ChangeIndexAction,
    ): Promise<ChangeIndexResult>
    {
        const inspection = await this.inspect(input);

        if (inspection.status !== "applicable")
        {
            return inspection;
        }

        const group = inspection.groups.find((candidate) => candidate.selector === selector);

        if (group === undefined)
        {
            return staleSelector(selector, inspection.groups.map(({ selector: available }) => available));
        }

        const targetState = action === "stage" ? "staged" : "unstaged";

        if (group.state === targetState)
        {
            return { status: "unchanged", state: targetState, group };
        }

        const segment = group.segments[0]!;
        const update: GitIndexUpdate = {
            head: inspection.head,
            repositoryPath: inspection.repositoryPath,
            headStart: segment.headStart,
            headEnd: segment.headEnd,
            replacementText: action === "stage" ? segment.worktreeText : segment.headText,
        };

        try
        {
            await this.applyIndexUpdate(update, input.signal);
        }
        catch (error)
        {
            return {
                status: "unavailable",
                reason: "index-write-failed",
                message: errorMessage(error),
            };
        }

        return { status: "applied", state: targetState, group };
    }

    async prepareUndo(input: ChangeInspectionInput, selector: string): Promise<PreparedUndoResult>
    {
        const inspection = await this.inspect(input);

        if (inspection.status !== "applicable")
        {
            return inspection;
        }

        const group = inspection.groups.find((candidate) => candidate.selector === selector);

        if (group === undefined)
        {
            return staleSelector(selector, inspection.groups.map(({ selector: available }) => available));
        }

        const worktreeText = reverseChangeGroup(input.worktreeText, group);

        if (worktreeText === undefined)
        {
            return staleSelector(selector, inspection.groups.map(({ selector: available }) => available));
        }

        const segment = group.segments[0]!;
        const indexUpdate = group.state === "unstaged"
            ? undefined
            : {
                head: inspection.head,
                repositoryPath: inspection.repositoryPath,
                headStart: segment.headStart,
                headEnd: segment.headEnd,
                replacementText: segment.headText,
            } satisfies GitIndexUpdate;

        return {
            status: "applied",
            worktreeText,
            group,
            ...(indexUpdate === undefined ? {} : { indexUpdate }),
        };
    }

    async applyIndexUpdate(update: GitIndexUpdate, signal?: AbortSignal): Promise<void>
    {
        const versions = await this.git.readTrackedRepositoryFile(update.repositoryPath, signal);

        if (versions.status !== "found")
        {
            throw new Error(
                versions.status === "untracked"
                    ? `${update.repositoryPath} is no longer tracked by HEAD`
                    : versions.message,
            );
        }

        if (versions.head !== update.head)
        {
            throw new Error(`Git HEAD changed while updating ${update.repositoryPath}`);
        }

        const nextIndexText = replaceHeadRangeInIndex(
            versions.headText,
            versions.indexText,
            update.headStart,
            update.headEnd,
            update.replacementText,
        );

        if (nextIndexText === versions.indexText)
        {
            return;
        }

        await this.git.writeIndexFile(update.repositoryPath, versions.indexMode, nextIndexText, signal);
    }
}

function staleSelector(selector: string, availableSelectors: readonly string[])
{
    return {
        status: "unavailable" as const,
        reason: "stale-selector" as const,
        message: `${selector} is not available in the current file state`,
        availableSelectors,
    };
}

function errorMessage(error: unknown): string
{
    return error instanceof Error ? error.message : String(error);
}
