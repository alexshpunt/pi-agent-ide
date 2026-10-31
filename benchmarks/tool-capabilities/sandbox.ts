import { spawn, execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
  stat,
  symlink,
  lstat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { CapabilityCase } from "./validation.ts";

/** A stopped process retains its real status and complete output, including timeouts. */
export interface ProcessResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Run a process with a bounded lifetime and terminate its owned process group on cancellation. */
export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Inherit the real terminal rather than capturing or forwarding terminal escape sequences. */
    terminal?: boolean;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const initialRawMode = process.stdin.isRaw;
    // A child changes the shared TTY's termios flags without updating this ReadStream's cache.
    const terminalState =
      options.terminal && process.stdin.isTTY
        ? execFileSync("stty", ["-g"], { stdio: [0, "pipe", "pipe"], encoding: "utf8" }).trim()
        : undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: options.terminal ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    let hardKill: NodeJS.Timeout | undefined;
    const stop = () => {
      if (!child.pid || hardKill) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* The group already exited. */
      }
      hardKill = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }, 1000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 180000);
    options.signal?.addEventListener("abort", stop, { once: true });
    const resize = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGWINCH");
      } catch {
        /* The group already exited. */
      }
    };
    if (options.terminal) process.on("SIGWINCH", resize);
    const restoreTerminal = (interrupted = false) => {
      if (!options.terminal) return;
      process.removeListener("SIGWINCH", resize);
      if (interrupted && process.stdout.isTTY) {
        // SIGTERM/SIGKILL can bypass Pi's shutdown. Do not leave its input/display modes in the shell.
        process.stdout.write(
          "\x1b[?2026l\x1b[?2004l\x1b[<u\x1b[>4;0m" +
            "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l" +
            "\x1b[?2031l\x1b[?1049l\x1b[?7h\x1b[?25h\x1b[0m",
        );
      }
      if (process.stdin.isTTY) process.stdin.setRawMode(initialRawMode);
      if (terminalState) execFileSync("stty", [terminalState], { stdio: [0, "ignore", "ignore"] });
    };
    child.stdout?.setEncoding("utf8").on("data", (value: string) => {
      stdout += value;
    });
    child.stderr?.setEncoding("utf8").on("data", (value: string) => {
      stderr += value;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      options.signal?.removeEventListener("abort", stop);
      try {
        restoreTerminal();
        reject(error);
      } catch (cleanupError) {
        reject(
          new AggregateError([error, cleanupError], "Process startup and terminal cleanup failed"),
        );
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      options.signal?.removeEventListener("abort", stop);
      try {
        restoreTerminal(
          signal !== null || ((timedOut || options.signal?.aborted === true) && code !== 0),
        );
        resolve({ code, signal, timedOut, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
    if (options.signal?.aborted) stop();
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Freeze current source and dependencies in a disposable clone; never reset the development checkout. */
export async function snapshotSource(
  repository: string,
  container: string,
): Promise<{ source: string; revision: string; digest: string }> {
  const source = path.join(container, "source");
  const revision = git(repository, ["rev-parse", "HEAD"]).trim();
  const cloned = await runProcess("git", [
    "clone",
    "--quiet",
    "--no-hardlinks",
    repository,
    source,
  ]);
  if (cloned.code !== 0) throw Error(cloned.stderr || "Source clone failed");
  const files = git(repository, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(
      (file) =>
        file &&
        !file.startsWith(".pi/extensions/") &&
        !file.startsWith(".pi/npm/") &&
        file !== ".pi/settings.json",
    );
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    const original = path.join(repository, file);
    const destination = path.join(source, file);
    if (!(await exists(original))) {
      await rm(destination, { force: true });
      continue;
    }
    const bytes = await readFile(original);
    hash.update(file).update("\0").update(bytes).update("\0");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  for (const manifest of files.filter((file) => path.basename(file) === "package.json")) {
    const relative = path.join(path.dirname(manifest), "node_modules");
    if (await exists(path.join(repository, relative)))
      await cp(path.join(repository, relative), path.join(source, relative), {
        recursive: true,
        verbatimSymlinks: true,
      });
  }
  git(source, [
    "-c",
    "user.name=Capability runner",
    "-c",
    "user.email=capabilities@example.invalid",
    "add",
    ".",
  ]);
  git(source, [
    "-c",
    "user.name=Capability runner",
    "-c",
    "user.email=capabilities@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "Freeze capability source",
  ]);
  return { source, revision, digest: hash.digest("hex") };
}

/** Prepare a fresh case clone and retain a byte snapshot for unchanged-file verification. */
export async function prepareTrial(
  parent: string,
  source: string,
  task: CapabilityCase,
): Promise<{ root: string; cwd: string; state: string; initial: Record<string, Buffer> }> {
  const root = await mkdtemp(path.join(parent, "trial-"));
  try {
    const workspace = path.join(root, "workspace");
    const cloned = await runProcess("git", [
      "clone",
      "--quiet",
      "--no-hardlinks",
      "--no-checkout",
      source,
      workspace,
    ]);
    if (cloned.code !== 0) throw Error(cloned.stderr);
    const cwd = path.join(workspace, "fixture");
    const state = path.join(root, "state");
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(state, "agent"), { recursive: true });
    await mkdir(path.join(state, "home"), { recursive: true });
    for (const [file, contents] of Object.entries(task.files ?? {})) {
      const target = path.resolve(cwd, file);
      if (!target.startsWith(cwd + path.sep)) throw Error("Fixture path leaves its case");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    if (task.setup === "pixel") await writeFile(path.join(cwd, "pixel.png"), pixelPng);
    if (task.setup === "media") {
      await cp(path.join(source, "assets/banner.png"), path.join(cwd, "sample.png"));
      const stream = "BT /F1 18 Tf 72 720 Td (PDF-MARKER) Tj ET";
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      ];
      let pdf = "%PDF-1.4\n";
      const offsets = [0];
      objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      });
      const xref = Buffer.byteLength(pdf);
      pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      await writeFile(path.join(cwd, "sample.pdf"), pdf);
    }
    if (task.git) {
      git(cwd, ["init", "--quiet"]);
      git(cwd, ["add", "."]);
      git(cwd, [
        "-c",
        "user.name=Capability fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Initial fixture",
      ]);
    }
    if (task.setup === "delete-temporary-no-git") {
      // The fixture's parent is the disposable source clone. Remove only its Git metadata
      // so the non-Git cases cannot inherit that worktree or ignore fixture-local settings.
      await rm(path.join(workspace, ".git"), { recursive: true });
    }
    if (task.setup === "delete-objects") {
      await mkdir(path.join(cwd, "remove-tree", "nested", "empty"), { recursive: true });
      await writeFile(path.join(cwd, "remove-tree", "nested", "data.bin"), Buffer.from([0, 10]));
      await symlink("missing", path.join(cwd, "remove-tree", "broken"));
      await writeFile(path.join(cwd, "remove-tree", "data"), "REMOVE\n");
      await symlink("/workspace/fixture/sentinel.txt", path.join(cwd, "remove-tree", "link"));
      await symlink("sentinel.txt", path.join(cwd, "link"));
      await symlink("missing", path.join(cwd, "broken-link"));
    }
    if (task.setup === "directory-transfers") {
      await mkdir(path.join(cwd, "source-tree", "nested", "empty"), { recursive: true });
      await writeFile(path.join(cwd, "source-tree", "nested", "data.bin"), Buffer.from([0, 10]));
      await symlink("/workspace/fixture/sentinel.txt", path.join(cwd, "source-tree", "link"));
      await symlink("missing", path.join(cwd, "source-tree", "broken"));
      await mkdir(path.join(cwd, "merge-target", "nested"), { recursive: true });
      await writeFile(path.join(cwd, "merge-target", "nested", "data.bin"), "OLD\n");
      await writeFile(path.join(cwd, "merge-target", "copy-only"), "KEEP\n");
      await mkdir(path.join(cwd, "moved-target"));
      await writeFile(path.join(cwd, "moved-target", "move-only"), "REMOVE\n");
      await symlink("sentinel.txt", path.join(cwd, "link"));
      await symlink("missing", path.join(cwd, "broken-link"));
    }
    const initial = await fixtureFiles(cwd, "", task.setup === "semantic-vera" ? "" : undefined);
    return { root, cwd, state, initial };
  } catch (error) {
    await cleanupTrial(parent, root);
    throw error;
  }
}

/** Read fixture bytes, ignoring only case-owned tool state and Git metadata. */
export async function fixtureFiles(
  root: string,
  prefix = "",
  veraIndexPrefix?: string,
): Promise<Record<string, Buffer>> {
  const entries: Record<string, Buffer> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if ([".git", ".pi", "node_modules"].includes(entry.name)) continue;
    if (veraIndexPrefix === prefix && entry.name === ".vera") continue;
    const file = path.join(prefix, entry.name);
    if (entry.isDirectory())
      Object.assign(entries, await fixtureFiles(root, file, veraIndexPrefix));
    else
      entries[file] = entry.isSymbolicLink()
        ? Buffer.from(`symlink:${await readlink(path.join(root, file))}`)
        : await readFile(path.join(root, file));
  }
  return entries;
}

/** A one-pixel PNG that Read returns unchanged, for the `pixel` setup. */
export const pixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
/** Validate final bytes, including files the task was not allowed to touch. */
export async function validateFiles(
  cwd: string,
  initial: Record<string, Buffer>,
  expected: Record<string, string | Buffer | null> = {},
  veraIndexPrefix?: string,
): Promise<string[]> {
  const actual = await fixtureFiles(cwd, "", veraIndexPrefix);
  const wanted = { ...initial };
  for (const [file, text] of Object.entries(expected)) {
    if (text === null) delete wanted[file];
    else wanted[file] = typeof text === "string" ? Buffer.from(text) : text;
  }
  const problems: string[] = [];
  for (const [file, text] of Object.entries(expected)) {
    if (text !== null) continue;
    const remains = await lstat(path.join(cwd, file)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (remains) problems.push(`Expected deleted object still exists: ${file}`);
  }
  for (const file of new Set([...Object.keys(actual), ...Object.keys(wanted)])) {
    if (!actual[file] || !wanted[file] || !actual[file].equals(wanted[file]))
      problems.push(`Unexpected final bytes: ${file}`);
  }
  return problems;
}

/** Build an OS sandbox with read-only tools and source, and only case-owned writable mounts. */
export async function sandboxArgs(
  source: string,
  root: string,
  connector?: { root: string; executable?: string; definition?: { claudeFileAuth?: boolean } },
): Promise<string[]> {
  const args = [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  // Claude Code rejects bypass-permissions under root; remap only explicit CLI runs.
  if (connector?.executable) args.push("--uid", "1000", "--gid", "1000");
  for (const mount of [
    "/usr",
    "/etc",
    "/opt",
    path.join(os.homedir(), ".local/bin"),
    path.join(os.homedir(), ".local/lib"),
  ])
    if (await exists(mount)) args.push("--ro-bind", mount, mount);
  for (const directory of ["bin", "sbin", "lib", "lib64"])
    args.push("--symlink", `usr/${directory}`, `/${directory}`);
  if (connector) {
    args.push("--ro-bind", connector.root, "/connector");
    if (connector.executable)
      args.push("--dir", "/tools", "--ro-bind", connector.executable, "/tools/claude");
    if (connector.definition?.claudeFileAuth) {
      if (connector.executable)
        throw new Error("Claude-file authentication cannot expose a Claude executable");
      const blocker = path.join(root, "claude-fallback-blocker");
      await writeFile(
        blocker,
        "#!/bin/sh\nprintf 'blocked\\n' >> /state/claude-fallback-attempted\nexit 126\n",
        { mode: 0o700 },
      );
      args.push("--dir", "/tools", "--ro-bind", blocker, "/tools/claude");
    }
  }
  const resolver = await import("node:fs/promises").then((fs) => fs.realpath("/etc/resolv.conf"));
  if (resolver !== "/etc/resolv.conf") args.push("--ro-bind", resolver, resolver);
  args.push(
    "--ro-bind",
    source,
    "/source",
    "--bind",
    path.join(root, "workspace"),
    "/workspace",
    "--bind",
    path.join(root, "state"),
    "/state",
    "--chdir",
    "/workspace/fixture",
    "--",
  );
  return args;
}

/** Remove only the exact disposable case directory owned by this runner. */
export async function cleanupTrial(parent: string, root: string): Promise<void> {
  if (path.dirname(root) !== parent || !path.basename(root).startsWith("trial-"))
    throw Error("Cleanup target is not a case-owned trial");
  await rm(root, { recursive: true, force: true });
}
