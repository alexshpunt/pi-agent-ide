import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiredValue } from "pi-agent-invariant";
import type { ReadFailure } from "pi-agent-read/api/tools/read";
import type { ResourceResolverContext } from "pi-agent-resource";

/** Suggest exact workspace paths after a missing-file error; never open candidate content. */
export async function recoverFilesystemPath(
  failure: ReadFailure,
  context: ResourceResolverContext,
): Promise<ReadFailure["candidates"]> {
  const cause = failure.cause;
  const deadline = Date.now() + 500;
  if (
    context.signal?.aborted ||
    failure.source === undefined ||
    typeof cause !== "object" ||
    cause === null ||
    !("code" in cause) ||
    cause.code !== "ENOENT"
  )
    return undefined;
  const source = failure.source.startsWith("file://")
    ? fileURLToPath(failure.source)
    : failure.source;
  const relative = path.relative(context.cwd, path.resolve(context.cwd, source));
  if (!insideWorkspace(relative) || relative.includes("#")) return undefined;
  const name = path.basename(relative).toLowerCase();
  if (name.length < 3 || name.length > 160) return undefined;
  const bundled = path.join(
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
    "bin",
    process.platform === "win32" ? "rg.exe" : "rg",
  );
  const files = await new Promise<string[]>((resolve) => {
    execFile(
      existsSync(bundled) ? bundled : "rg",
      ["--files", "--hidden", "--no-config", "--no-ignore-parent", "--null", "--glob", "!.git/**"],
      {
        cwd: context.cwd,
        timeout: 250,
        maxBuffer: 2 * 1024 * 1024,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      (error, stdout) => resolve(error ? [] : stdout.split("\0").filter(Boolean).slice(0, 20000)),
    );
  });
  const maximumDistance = Math.min(3, Math.max(1, Math.floor(name.length * 0.2)));
  const ranked = files
    .flatMap((file) => {
      if (context.signal?.aborted || Date.now() > deadline || !insideWorkspace(file)) return [];
      const candidateName = path.basename(file).toLowerCase();
      if (
        candidateName.length > 160 ||
        Math.abs(candidateName.length - name.length) > maximumDistance
      )
        return [];
      const distance = editDistance(name, candidateName);
      if (distance > maximumDistance) return [];
      const directory = path.dirname(relative).toLowerCase();
      const candidateDirectory = path.dirname(file).toLowerCase();
      return [
        { path: file, distance, directoryDistance: directory === candidateDirectory ? 0 : 1 },
      ];
    })
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.directoryDistance - right.directoryDistance ||
        left.path.localeCompare(right.path),
    );
  const candidates: { path: string }[] = [];
  const root = await realpath(context.cwd);
  for (const candidate of ranked.slice(0, 20)) {
    if (context.signal?.aborted || Date.now() > deadline) return undefined;
    try {
      const target = await realpath(path.resolve(context.cwd, candidate.path));
      if (insideWorkspace(path.relative(root, target))) candidates.push({ path: candidate.path });
    } catch {
      // Ignore files removed while searching.
    }
    if (candidates.length === 3) break;
  }
  return candidates.length ? candidates : undefined;
}

function insideWorkspace(relative: string): boolean {
  return relative !== "" && !/^\.\.(?:[\\/]|$)/u.test(relative) && !path.isAbsolute(relative);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        requiredValue(current[column - 1]) + 1,
        requiredValue(previous[column]) + 1,
        requiredValue(previous[column - 1]) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return requiredValue(previous[right.length]);
}
