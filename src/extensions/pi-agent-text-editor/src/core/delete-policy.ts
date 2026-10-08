import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { requiredValue } from "pi-agent-invariant";
import type { BeforeDeleteEvent, DeleteFileAccess } from "#src/api/delete-guard.js";

const exec = promisify(execFile);

/** Host-only deletion dependencies; these are not agent parameters. */
export interface DeletePolicyContext {
  readonly beforeDelete?: (event: BeforeDeleteEvent) => Promise<void>;
  readonly confirm?: (event: BeforeDeleteEvent, reason: string) => Promise<boolean>;
  readonly files?: DeleteFileAccess;
}

const localFiles: DeleteFileAccess = {
  realpath,
  async inspect(source) {
    const stat = await lstat(source);
    return {
      kind: stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "file"
            : "other",
      revision: JSON.stringify([
        stat.dev,
        stat.ino,
        stat.birthtimeMs,
        stat.ctimeMs,
        stat.mtimeMs,
        stat.size,
        stat.mode,
      ]),
    };
  },
  read: (source) => readFile(source, "utf8"),
  git,
  source: (source) => source,
};
interface Project {
  readonly root?: string;
  readonly controls: readonly string[];
  readonly gitAvailable: boolean;
}

/** Check policy and hooks, obtain any required approval, then verify the same object again. */
export async function prepareDeletion(
  source: string,
  cwd: string,
  context: DeletePolicyContext,
  signal?: AbortSignal,
): Promise<BeforeDeleteEvent & { readonly revision: string }> {
  const before = await inspectDeletion(source, cwd, signal, context.files);
  const event =
    context.files === undefined
      ? before.event
      : {
          ...before.event,
          path: context.files.source(before.event.path),
          resolvedPath: context.files.source(before.event.resolvedPath),
          cwd: context.files.source(before.event.cwd),
        };
  await context.beforeDelete?.(event);
  signal?.throwIfAborted();
  if (before.reason !== undefined) {
    if (context.confirm === undefined)
      fail(
        "DELETE_CONFIRMATION_REQUIRED",
        `Deletion blocked: no user dialog is available. ${before.reason}`,
      );
    if (!(await context.confirm(event, before.reason)))
      fail("DELETE_NOT_APPROVED", "Deletion was not approved by the user.");
  }
  signal?.throwIfAborted();
  let after;
  try {
    after = await inspectDeletion(source, cwd, signal, context.files);
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
  return { ...after.event, revision: after.revision };
}

async function inspectDeletion(
  source: string,
  cwd: string,
  signal?: AbortSignal,
  files?: DeleteFileAccess,
) {
  const access = files ?? localFiles;
  const paths = files === undefined ? path : path.posix;
  signal?.throwIfAborted();
  // Resolve ancestors without dereferencing the link that will be unlinked.
  const resolvedPath = paths.join(
    await access.realpath(paths.dirname(source)),
    paths.basename(source),
  );
  const stat = await access.inspect(resolvedPath);
  const kind = stat.kind;
  if (kind === "other")
    fail("INVALID_FILE_TYPE", "Delete supports regular files, directories, and symlinks.");
  const project = await findProject(cwd, signal, files);
  const currentDirectory = await access.realpath(cwd);
  const boundary = project.root ?? currentDirectory;
  if (
    contains(resolvedPath, boundary, paths) ||
    resolvedPath === paths.parse(resolvedPath).root ||
    project.controls.some(
      (control) => contains(control, resolvedPath, paths) || contains(resolvedPath, control, paths),
    )
  )
    fail(
      "DELETE_PROTECTED_TARGET",
      `Cannot delete protected project, ancestor, filesystem root, or Git control path: ${source}`,
    );

  let reason: string | undefined;
  let tracked: string[] = [];
  if (kind !== "file") {
    if (!project.gitAvailable || project.root === undefined) {
      reason = "No Git worktree or reliable Git check is available.";
    } else if (!contains(project.root, resolvedPath, paths)) {
      reason = "Target is outside the current Git worktree.";
    } else {
      try {
        const entries = (
          await access.git(project.root, ["ls-files", "--cached", "--full-name", "-z"], signal)
        )
          .split("\0")
          .filter(Boolean);
        tracked = entries
          .filter((entry) =>
            contains(resolvedPath, paths.resolve(requiredValue(project.root), entry), paths),
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
    revision: stat.revision,
    snapshot: JSON.stringify({
      resolvedPath,
      kind,
      revision: stat.revision,
      boundary,
      controls: project.controls,
      reason,
      tracked,
    }),
  };
}

async function findProject(
  cwd: string,
  signal?: AbortSignal,
  files?: DeleteFileAccess,
): Promise<Project> {
  const access = files ?? localFiles;
  const paths = files === undefined ? path : path.posix;
  try {
    const output = (
      await access.git(
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
    const [root, gitDir, commonDir] = await Promise.all(
      output.map((entry) => access.realpath(entry)),
    );
    return {
      root,
      controls: [
        paths.join(requiredValue(root), ".git"),
        requiredValue(gitDir),
        requiredValue(commonDir),
      ].sort(),
      gitAvailable: true,
    };
  } catch {
    signal?.throwIfAborted();
    // Preserve root/control protection even when Git is unavailable or its metadata is broken.
    let directory = await access.realpath(cwd);
    for (;;) {
      const marker = paths.join(directory, ".git");
      const stat = await access.inspect(marker).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (stat !== undefined) {
        const controls = [marker];
        if (stat.kind === "directory" || stat.kind === "symlink")
          controls.push(await access.realpath(marker));
        else if (stat.kind === "file") {
          const content = await access.read(marker);
          const reference = /^gitdir: (.+)\r?\n?$/u.exec(content)?.[1];
          if (reference === undefined)
            fail("DELETE_GIT_PROTECTION_FAILED", "Cannot identify current Git control data.");
          const gitDir = await access.realpath(paths.resolve(directory, reference));
          controls.push(gitDir);
          const common = await access
            .read(paths.join(gitDir, "commondir"))
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
          if (common !== undefined)
            controls.push(await access.realpath(paths.resolve(gitDir, common.trimEnd())));
        } else fail("DELETE_GIT_PROTECTION_FAILED", "Cannot identify current Git control data.");
        return { root: directory, controls: controls.sort(), gitAvailable: false };
      }
      const parent = paths.dirname(directory);
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

function contains(parent: string, child: string, paths = path): boolean {
  const relative = paths.relative(parent, child);
  return (
    relative === "" ||
    // This checks containment; it does not construct a parent-relative path.
    // eslint-disable-next-line repo/no-parent-paths
    (!paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`))
  );
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, effect: "not-applied" });
}
