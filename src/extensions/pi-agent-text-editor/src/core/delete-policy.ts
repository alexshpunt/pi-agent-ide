import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { requiredValue } from "pi-agent-invariant";
import type { BeforeDeleteEvent } from "#src/api/delete-guard.js";

const exec = promisify(execFile);

/** Host-only deletion dependencies; these are not agent parameters. */
export interface DeletePolicyContext {
  readonly beforeDelete?: (event: BeforeDeleteEvent) => Promise<void>;
  readonly confirm?: (event: BeforeDeleteEvent, reason: string) => Promise<boolean>;
}

interface Project {
  readonly root?: string;
  readonly controls: readonly string[];
  readonly gitAvailable: boolean;
}

/** A host approval that must be checked again immediately before removal. */
export interface DeletionGuard {
  readonly event: BeforeDeleteEvent;
  readonly verify: () => Promise<void>;
}

/** Check policy and hooks, obtain any required approval, then verify the same object again. */
export async function prepareDeletion(
  source: string,
  cwd: string,
  context: DeletePolicyContext,
  signal?: AbortSignal,
): Promise<BeforeDeleteEvent> {
  const guard = await prepareDeletionGuard(source, cwd, context, signal);
  await guard.verify();
  return guard.event;
}

/** Keep approval checks available when one operation removes more than one object. */
export async function prepareDeletionGuard(
  source: string,
  cwd: string,
  context: DeletePolicyContext,
  signal?: AbortSignal,
): Promise<DeletionGuard> {
  const before = await inspectDeletion(source, cwd, signal);
  await context.beforeDelete?.(before.event);
  signal?.throwIfAborted();
  if (before.reason !== undefined) {
    if (context.confirm === undefined)
      fail(
        "DELETE_CONFIRMATION_REQUIRED",
        `Deletion blocked: no user dialog is available. ${before.reason}`,
      );
    if (!(await context.confirm(before.event, before.reason)))
      fail("DELETE_NOT_APPROVED", "Deletion was not approved by the user.");
  }
  signal?.throwIfAborted();
  return {
    event: before.event,
    verify: async () => {
      signal?.throwIfAborted();
      let after;
      try {
        after = await inspectDeletion(source, cwd, signal);
      } catch (error) {
        signal?.throwIfAborted();
        fail(
          "DELETE_TARGET_CHANGED",
          `Deletion target cannot be verified again: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (before.snapshot !== after.snapshot)
        fail(
          "DELETE_TARGET_CHANGED",
          "Deletion target or its safety classification changed. Nothing was removed; make a new request.",
        );
      signal?.throwIfAborted();
    },
  };
}

async function inspectDeletion(source: string, cwd: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // Resolve ancestors without dereferencing the link that will be unlinked.
  const resolvedPath = path.join(await realpath(path.dirname(source)), path.basename(source));
  const stat = await lstat(resolvedPath);
  const kind = stat.isSymbolicLink()
    ? "symlink"
    : stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : undefined;
  if (kind === undefined)
    fail("INVALID_FILE_TYPE", "Delete supports regular files, directories, and symlinks.");
  const project = await findProject(cwd, signal);
  const boundary = project.root ?? (await realpath(cwd));
  assertUnprotected(resolvedPath, boundary, project.controls);

  let reason: string | undefined;
  let tracked: string[] = [];
  if (kind !== "file") {
    if (!project.gitAvailable || project.root === undefined) {
      reason = "No Git worktree or reliable Git check is available.";
    } else if (!contains(project.root, resolvedPath)) {
      reason = "Target is outside the current Git worktree.";
    } else {
      try {
        const entries = (
          await git(project.root, ["ls-files", "--cached", "--full-name", "-z"], signal)
        )
          .split("\0")
          .filter(Boolean);
        tracked = entries
          .filter((entry) =>
            contains(resolvedPath, path.resolve(requiredValue(project.root), entry)),
          )
          .sort();
        if (tracked.length > 0)
          reason = "Target is tracked by Git or contains tracked or staged entries.";
      } catch {
        signal?.throwIfAborted();
        reason = "Git tracking check failed.";
      }
    }
  }
  const event: BeforeDeleteEvent = {
    path: source,
    resolvedPath,
    cwd,
    kind,
    recursive: kind === "directory",
    ...(signal === undefined ? {} : { signal }),
  };
  return {
    event,
    reason,
    snapshot: JSON.stringify({
      resolvedPath,
      kind,
      dev: stat.dev,
      ino: stat.ino,
      birthtime: stat.birthtimeMs,
      ctime: stat.ctimeMs,
      mtime: stat.mtimeMs,
      size: stat.size,
      boundary,
      controls: project.controls,
      reason,
      tracked,
    }),
  };
}

/** Protect recursive transfer destinations, including paths that do not exist yet. */
export async function assertUnprotectedTransferPath(
  resolvedPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  const project = await findProject(cwd, signal);
  assertUnprotected(resolvedPath, project.root ?? (await realpath(cwd)), project.controls);
}

function assertUnprotected(resolvedPath: string, boundary: string, controls: readonly string[]) {
  if (
    contains(resolvedPath, boundary) ||
    resolvedPath === path.parse(resolvedPath).root ||
    controls.some((control) => contains(control, resolvedPath) || contains(resolvedPath, control))
  )
    fail(
      "DELETE_PROTECTED_TARGET",
      `Cannot remove or overwrite protected project, ancestor, filesystem root, or Git control path: ${resolvedPath}`,
    );
}
async function findProject(cwd: string, signal?: AbortSignal): Promise<Project> {
  try {
    const output = (
      await git(
        cwd,
        [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--absolute-git-dir",
          "--git-common-dir",
        ],
        signal,
      )
    )
      .trimEnd()
      .split("\n");
    if (output.length !== 3) throw new Error("Unexpected Git worktree paths");
    const [root, gitDir, commonDir] = await Promise.all(output.map((entry) => realpath(entry)));
    return {
      root,
      controls: [
        path.join(requiredValue(root), ".git"),
        requiredValue(gitDir),
        requiredValue(commonDir),
      ].sort(),
      gitAvailable: true,
    };
  } catch {
    signal?.throwIfAborted();
    // Preserve root/control protection even when Git is unavailable or its metadata is broken.
    let directory = await realpath(cwd);
    for (;;) {
      const marker = path.join(directory, ".git");
      const stat = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat !== undefined) {
        const controls = [marker];
        if (stat.isDirectory() || stat.isSymbolicLink()) controls.push(await realpath(marker));
        else if (stat.isFile()) {
          const content = await readFile(marker, "utf8");
          const reference = /^gitdir: (.+)\r?\n?$/u.exec(content)?.[1];
          if (reference === undefined)
            fail("DELETE_GIT_PROTECTION_FAILED", "Cannot identify current Git control data.");
          const gitDir = await realpath(path.resolve(directory, reference));
          controls.push(gitDir);
          const common = await readFile(path.join(gitDir, "commondir"), "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            },
          );
          if (common !== undefined)
            controls.push(await realpath(path.resolve(gitDir, common.trimEnd())));
        } else fail("DELETE_GIT_PROTECTION_FAILED", "Cannot identify current Git control data.");
        return { root: directory, controls: controls.sort(), gitAvailable: false };
      }
      const parent = path.dirname(directory);
      if (parent === directory) return { controls: [], gitAvailable: false };
      directory = parent;
    }
  }
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
    signal,
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    // This checks containment; it does not construct a parent-relative path.
    // eslint-disable-next-line repo/no-parent-paths
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
