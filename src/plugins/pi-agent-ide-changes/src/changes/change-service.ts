import { requiredValue } from "pi-agent-invariant";
import {
  createChangeGroups,
  replaceHeadRangeInIndex,
  reverseChangeGroup,
} from "./change-groups.ts";
import { GitChangesBackend } from "./git-changes-backend.ts";

import type {
  ChangeIndexAction,
  ChangeIndexResult,
  ChangeInspection,
  ChangeInspectionInput,
  GitIndexUpdate,
  PreparedUndoResult,
} from "./change-types.ts";
import type { GitCommandExecutor } from "./git-changes-backend.ts";

export type ChangeServiceCreation =
  | { readonly status: "ready"; readonly service: ChangeService }
  | { readonly status: "unavailable"; readonly reason: "no-worktree"; readonly message: string };

export class ChangeService {
  static async create(
    executor: GitCommandExecutor,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ChangeServiceCreation> {
    const creation = await GitChangesBackend.create(executor, cwd, signal);

    if (creation.status === "unavailable") {
      return creation;
    }

    return { status: "ready", service: new ChangeService(creation.backend) };
  }

  private constructor(private readonly git: GitChangesBackend) {}

  async inspect(input: ChangeInspectionInput): Promise<ChangeInspection> {
    return (await this.inspectNormalized(input)).inspection;
  }

  /** Inspect with CRLF worktree text compared as Git stores it (LF), when Git converts it. */
  private async inspectNormalized(input: ChangeInspectionInput): Promise<{
    readonly inspection: ChangeInspection;
    /** The worktree text the groups describe. */
    readonly comparable: string;
    /** Rebuild the worktree's line endings; undefined when they cannot be rebuilt exactly. */
    readonly restore: (text: string) => string | undefined;
  }> {
    const unchanged = (inspection: ChangeInspection) => ({
      inspection,
      comparable: input.worktreeText,
      restore: (text: string): string | undefined => text,
    });
    if (input.worktreeText.includes("\0")) {
      return unchanged({
        status: "unavailable",
        reason: "binary",
        message: "worktree file contains binary content",
      });
    }

    const versions = await this.git.readTrackedFile(input.source, input.cwd, input.signal);

    if (versions.status !== "found") {
      return unchanged(
        versions.status === "untracked"
          ? { status: "not-applicable", reason: "untracked" }
          : versions,
      );
    }

    if (versions.headText.includes("\0") || versions.indexText.includes("\0")) {
      return unchanged({
        status: "unavailable",
        reason: "binary",
        message: "Git file state contains binary content",
      });
    }

    // With `core.autocrlf` or an `eol` attribute, a CRLF worktree file matches LF blobs.
    const converts =
      input.worktreeText.includes("\r\n") &&
      !versions.headText.includes("\r\n") &&
      !versions.indexText.includes("\r\n") &&
      (await this.git.normalizesLineEndings(versions.repositoryPath, input.signal));
    const comparable = converts ? input.worktreeText.replaceAll("\r\n", "\n") : input.worktreeText;
    // Only a uniformly CRLF file can be rebuilt exactly from its LF form.
    const uniform = !/(?:^|[^\r])\n/u.test(input.worktreeText);
    const restore = (text: string): string | undefined =>
      !converts ? text : uniform ? text.replaceAll("\n", "\r\n") : undefined;

    const groups = createChangeGroups(
      versions.repositoryPath,
      versions.headText,
      versions.indexText,
      comparable,
    );

    if (groups.length === 0) {
      return { inspection: { status: "not-applicable", reason: "clean" }, comparable, restore };
    }

    return {
      inspection: {
        status: "applicable",
        head: versions.head,
        repositoryRoot: versions.repositoryRoot,
        repositoryPath: versions.repositoryPath,
        groups,
      },
      comparable,
      restore,
    };
  }

  async changeIndex(
    input: ChangeInspectionInput,
    selector: string,
    action: ChangeIndexAction,
  ): Promise<ChangeIndexResult> {
    const inspection = await this.inspect(input);

    if (inspection.status !== "applicable") {
      return inspection;
    }

    const group = inspection.groups.find((candidate) => candidate.selector === selector);

    if (group === undefined) {
      return staleSelector(
        selector,
        inspection.groups.map(({ selector: available }) => available),
      );
    }

    const targetState = action === "stage" ? "staged" : "unstaged";

    if (group.state === targetState) {
      return { status: "unchanged", state: targetState, group };
    }

    const segment = requiredValue(group.segments[0]);
    const update: GitIndexUpdate = {
      expectedWorktreeText: input.worktreeText,
      head: inspection.head,
      repositoryPath: inspection.repositoryPath,
      headStart: segment.headStart,
      headEnd: segment.headEnd,
      replacementText: action === "stage" ? segment.worktreeText : segment.headText,
    };

    try {
      await this.applyIndexUpdate(update, input.signal);
    } catch (error) {
      return {
        status: "unavailable",
        reason: "index-write-failed",
        message: errorMessage(error),
        failure: error instanceof Error ? error : new Error(errorMessage(error)),
      };
    }

    return { status: "applied", state: targetState, group };
  }

  async prepareUndo(input: ChangeInspectionInput, selector: string): Promise<PreparedUndoResult> {
    const { inspection, comparable, restore } = await this.inspectNormalized(input);

    if (inspection.status !== "applicable") {
      return inspection;
    }

    const group = inspection.groups.find((candidate) => candidate.selector === selector);

    if (group === undefined) {
      return staleSelector(
        selector,
        inspection.groups.map(({ selector: available }) => available),
      );
    }

    // Groups describe the text as Git stores it; reverse there, then restore CRLF.
    const reversed = reverseChangeGroup(comparable, group);
    const worktreeText = reversed === undefined ? undefined : restore(reversed);

    if (worktreeText === undefined) {
      return reversed === undefined
        ? staleSelector(
            selector,
            inspection.groups.map(({ selector: available }) => available),
          )
        : {
            status: "unavailable",
            reason: "mixed-line-endings",
            message:
              "the file mixes CRLF and LF line endings, so the change cannot be reversed exactly",
          };
    }

    const segment = requiredValue(group.segments[0]);
    const indexUpdate =
      group.state === "unstaged"
        ? undefined
        : ({
            head: inspection.head,
            repositoryPath: inspection.repositoryPath,
            headStart: segment.headStart,
            headEnd: segment.headEnd,
            replacementText: segment.headText,
            expectedWorktreeText: worktreeText,
          } satisfies GitIndexUpdate);

    return {
      status: "applied",
      worktreeText,
      group,
      ...(indexUpdate !== undefined && { indexUpdate }),
    };
  }

  async applyIndexUpdate(update: GitIndexUpdate, signal?: AbortSignal): Promise<void> {
    const versions = await this.git.readTrackedRepositoryFile(update.repositoryPath, signal);

    if (versions.status !== "found") {
      throw new Error(
        versions.status === "untracked"
          ? `${update.repositoryPath} is no longer tracked by HEAD`
          : versions.message,
      );
    }

    if (versions.head !== update.head) {
      throw new Error(`Git HEAD changed while updating ${update.repositoryPath}`);
    }

    const nextIndexText = replaceHeadRangeInIndex(
      versions.headText,
      versions.indexText,
      update.headStart,
      update.headEnd,
      update.replacementText,
    );

    if (nextIndexText === versions.indexText) {
      return;
    }

    await this.git.writeIndexFile(
      update.repositoryPath,
      versions.indexMode,
      nextIndexText,
      signal,
      {
        expectedHead: versions.head,
        expectedIndexText: versions.indexText,
        expectedIndexMode: versions.indexMode,
        expectedIndexExists: versions.indexExists,
        ...(update.expectedWorktreeText !== undefined && {
          expectedWorktreeText: update.expectedWorktreeText,
        }),
      },
    );
  }
}

function staleSelector(selector: string, availableSelectors: readonly string[]) {
  return {
    status: "unavailable" as const,
    reason: "stale-selector" as const,
    message: `${selector} is not available in the current file state`,
    availableSelectors,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
