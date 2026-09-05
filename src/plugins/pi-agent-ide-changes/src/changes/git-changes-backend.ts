import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface GitCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandExecutor {
  exec(
    command: string,
    arguments_: string[],
    options: { readonly cwd: string; readonly signal?: AbortSignal },
  ): Promise<GitCommandResult>;
}

export type GitChangesBackendCreation =
  | { readonly status: "ready"; readonly backend: GitChangesBackend }
  | { readonly status: "unavailable"; readonly reason: "no-worktree"; readonly message: string };

export interface TrackedFileVersions {
  readonly status: "found";
  readonly head: string;
  readonly repositoryPath: string;
  readonly repositoryRoot: string;
  readonly headText: string;
  readonly indexText: string;
  readonly indexMode: string;
}

export type TrackedFileLookup =
  | TrackedFileVersions
  | { readonly status: "untracked" }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "conflicted"
        | "head-file-lookup-failed"
        | "index-file-lookup-failed"
        | "missing-head"
        | "outside-worktree";
      readonly message: string;
    };

interface GitTreeEntry {
  readonly mode: string;
  readonly blob: string;
  readonly path: string;
}

interface GitIndexEntry extends GitTreeEntry {
  readonly stage: number;
}

export class GitChangesBackend {
  static async create(
    executor: GitCommandExecutor,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GitChangesBackendCreation> {
    const result = await executor.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      ...(signal !== undefined && { signal }),
    });

    if (result.code !== 0) {
      return {
        status: "unavailable",
        reason: "no-worktree",
        message: result.stderr.trim() || "not inside a Git worktree",
      };
    }

    return {
      status: "ready",
      backend: new GitChangesBackend(executor, path.resolve(result.stdout.trim())),
    };
  }

  private constructor(
    private readonly executor: GitCommandExecutor,
    readonly repositoryRoot: string,
  ) {}

  async readTrackedFile(
    source: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<TrackedFileLookup> {
    const absoluteSource = path.resolve(cwd, source);
    const repoPath = path.relative(this.repositoryRoot, absoluteSource);

    // oxlint-disable-next-line repo/no-parent-paths -- defensive check against traversal, not a traversal
    if (repoPath === ".." || repoPath.startsWith(`..${path.sep}`) || path.isAbsolute(repoPath)) {
      return {
        status: "unavailable",
        reason: "outside-worktree",
        message: `${absoluteSource} is outside ${this.repositoryRoot}`,
      };
    }

    return this.readTrackedRepositoryFile(repoPath.split(path.sep).join("/"), signal);
  }

  async readTrackedRepositoryFile(
    repoPath: string,
    signal?: AbortSignal,
  ): Promise<TrackedFileLookup> {
    const head = await this.git(["rev-parse", "--verify", "HEAD"], signal);

    if (head.code !== 0) {
      return {
        status: "unavailable",
        reason: "missing-head",
        message: head.stderr.trim() || "Git HEAD does not exist",
      };
    }

    const tree = await this.git(
      ["--literal-pathspecs", "ls-tree", "-z", "HEAD", "--", repoPath],
      signal,
    );

    if (tree.code !== 0) {
      return {
        status: "unavailable",
        reason: "head-file-lookup-failed",
        message: tree.stderr.trim() || `could not inspect HEAD:${repoPath}`,
      };
    }

    const headEntry = parseTreeEntry(tree.stdout);

    if (headEntry === undefined) {
      return { status: "untracked" };
    }

    const headBlob = await this.readBlob(headEntry.blob, "HEAD", repoPath, signal);

    if (headBlob.status !== "found") {
      return headBlob;
    }

    const index = await this.git(
      ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", repoPath],
      signal,
    );

    if (index.code !== 0) {
      return {
        status: "unavailable",
        reason: "index-file-lookup-failed",
        message: index.stderr.trim() || `could not inspect the index entry for ${repoPath}`,
      };
    }

    const indexEntries = parseIndexEntries(index.stdout);

    if (indexEntries.some(({ stage }) => stage !== 0)) {
      return {
        status: "unavailable",
        reason: "conflicted",
        message: `${repoPath} has unresolved Git index entries`,
      };
    }

    const indexEntry = indexEntries.find(({ stage }) => stage === 0);
    let indexText = "";

    if (indexEntry !== undefined) {
      const indexBlob = await this.readBlob(indexEntry.blob, "index", repoPath, signal);

      if (indexBlob.status !== "found") {
        return indexBlob;
      }

      indexText = indexBlob.text;
    }

    return {
      status: "found",
      head: head.stdout.trim(),
      repositoryPath: repoPath,
      repositoryRoot: this.repositoryRoot,
      headText: headBlob.text,
      indexText,
      indexMode: indexEntry?.mode ?? headEntry.mode,
    };
  }

  async writeIndexFile(
    repoPath: string,
    mode: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-agent-index-"));
    const temporaryFile = path.join(temporaryDirectory, "content");

    try {
      await writeFile(temporaryFile, text, "utf8");
      const blob = await this.git(
        ["hash-object", "-w", `--path=${repoPath}`, temporaryFile],
        signal,
      );

      if (blob.code !== 0 || blob.stdout.trim().length === 0) {
        throw new Error(blob.stderr.trim() || `could not write a Git blob for ${repoPath}`);
      }

      const update = await this.git(
        ["update-index", "--add", "--cacheinfo", mode, blob.stdout.trim(), repoPath],
        signal,
      );

      if (update.code !== 0) {
        throw new Error(
          update.stderr.trim() || `could not update the Git index entry for ${repoPath}`,
        );
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async readBlob(
    blob: string,
    source: "HEAD" | "index",
    repoPath: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly status: "found"; readonly text: string }
    | {
        readonly status: "unavailable";
        readonly reason: "head-file-lookup-failed" | "index-file-lookup-failed";
        readonly message: string;
      }
  > {
    const result = await this.git(["cat-file", "blob", blob], signal);

    if (result.code !== 0) {
      return {
        status: "unavailable",
        reason: source === "HEAD" ? "head-file-lookup-failed" : "index-file-lookup-failed",
        message: result.stderr.trim() || `could not read ${source}:${repoPath}`,
      };
    }

    return { status: "found", text: result.stdout };
  }

  private git(arguments_: string[], signal?: AbortSignal): Promise<GitCommandResult> {
    return this.executor.exec("git", arguments_, {
      cwd: this.repositoryRoot,
      ...(signal !== undefined && { signal }),
    });
  }
}

function parseTreeEntry(output: string): GitTreeEntry | undefined {
  const record = output.split("\0", 1)[0];

  if (record === undefined || record.length === 0) {
    return undefined;
  }

  const separator = record.indexOf("\t");

  if (separator === -1) {
    return undefined;
  }

  const [mode, type, blob] = record.slice(0, separator).split(" ", 3);

  return mode === undefined || type !== "blob" || blob === undefined
    ? undefined
    : { mode, blob, path: record.slice(separator + 1) };
}

function parseIndexEntries(output: string): GitIndexEntry[] {
  return output
    .split("\0")
    .filter(Boolean)
    .flatMap((record) => {
      const separator = record.indexOf("\t");

      if (separator === -1) {
        return [];
      }

      const [mode, blob, stageValue] = record.slice(0, separator).split(" ", 3);
      const stage = Number(stageValue);

      return mode === undefined || blob === undefined || !Number.isInteger(stage)
        ? []
        : [{ mode, blob, stage, path: record.slice(separator + 1) }];
    });
}

export function extensionGitExecutor(pi: ExtensionAPI): GitCommandExecutor {
  return {
    exec: (command, arguments_, options) => pi.exec(command, arguments_, options),
  };
}
