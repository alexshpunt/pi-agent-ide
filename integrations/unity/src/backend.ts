import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { inspectInstallation } from "./install.ts";
import { ensureCli } from "./auto-install.ts";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { selectEditor, type EditorInstance } from "./target.ts";
import {
  parseRemoteProject,
  remoteProject,
  sshArguments,
  sshTarget,
  sshTargets,
  type SshTarget,
} from "./remote.ts";

const execFileAsync = promisify(execFile);
const command = () => process.env.PI_UNITY_CLI || "unity";
const remoteCommand = () => process.env.PI_UNITY_REMOTE_CLI || "unity";

function localPath(): string {
  return [
    process.env.PATH || "",
    path.join(process.env.HOME || os.homedir(), ".local", "share", "pi-agent-unity", "bin"),
    path.join(process.env.HOME || os.homedir(), ".local", "bin"),
    path.join(process.env.HOME || os.homedir(), ".unity", "bin"),
  ]
    .filter(Boolean)
    .join(path.delimiter);
}

async function invocation(
  args: string[],
  target?: SshTarget,
  signal?: AbortSignal,
): Promise<{ command: string; args: string[] }> {
  if (target)
    return {
      command: "ssh",
      args: sshArguments(target, remoteCommand(), args, !process.env.PI_UNITY_REMOTE_CLI),
    };
  if (!process.env.PI_UNITY_CLI && (process.platform === "linux" || process.platform === "win32")) {
    const directories = localPath().split(path.delimiter);
    const has = async (name: string) => {
      for (const dir of directories) {
        try {
          await access(path.join(dir, name), constants.X_OK);
          return true;
        } catch {
          /* Try the next directory. */
        }
      }
      return false;
    };
    const hasCli =
      (await has("unity")) || (process.platform === "win32" && (await has("unity.exe")));
    if (!hasCli && (process.platform === "win32" || (await has("wslpath")))) {
      const inspection = await inspectInstallation(undefined, signal);
      if (inspection.state === "found" && inspection.executable)
        return { command: inspection.executable, args };
    }
  }
  return { command: command(), args };
}

export async function cli(
  args: string[],
  signal?: AbortSignal,
  target?: SshTarget,
  installed = false,
): Promise<unknown> {
  const run = await invocation([...args, "--json", "--non-interactive"], target, signal);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(run.command, run.args, {
      signal,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: target ? process.env : { ...process.env, PATH: localPath() },
    }));
  } catch (error) {
    signal?.throwIfAborted();
    const failure = error as { code?: string | number; stderr?: string; stdout?: string };
    let envelope: { success?: boolean; errors?: unknown } | undefined;
    if (failure.stdout) {
      try {
        envelope = JSON.parse(failure.stdout) as { success?: boolean; errors?: unknown };
      } catch {
        /* Not a Unity JSON response. */
      }
    }
    if (envelope?.success === false && envelope.errors)
      throw Object.assign(new Error(JSON.stringify(envelope.errors), { cause: error }), {
        unityErrors: envelope.errors,
      });
    const missing = target
      ? failure.code === 127 &&
        failure.stderr?.split(/\r?\n/).includes("PI_UNITY_COMMAND_NOT_FOUND")
      : failure.code === "ENOENT";
    const invalid = target
      ? failure.code === 126 && failure.stderr?.split(/\r?\n/).includes("PI_UNITY_COMMAND_INVALID")
      : failure.code === "EACCES";
    if (!missing && !invalid) throw error;
    const explicit = Boolean(
      invalid || (target ? process.env.PI_UNITY_REMOTE_CLI : process.env.PI_UNITY_CLI),
    );
    const name = target?.id ?? "local";
    let detail = "The configured Unity CLI executable is unavailable; check its path.";
    if (!explicit) {
      // Install the official CLI once, then retry the request that needed it.
      const readiness = installed
        ? { available: false, detail: "The Unity CLI is still not found after installation." }
        : await ensureCli(target, signal);
      if (readiness.available) return cli(args, signal, target, true);
      detail =
        `Unity CLI was not found. ${readiness.detail ?? ""} Discover unity_install_cli for details.`.replace(
          /\s+/g,
          " ",
        );
    }
    throw Object.assign(new Error(`${name}: ${detail}`, { cause: error }), {
      code: explicit ? "UNITY_CLI_INVALID" : "UNITY_CLI_MISSING",
      target: name,
    });
  }
  const envelope = JSON.parse(stdout) as { success: boolean; errors?: unknown; data?: unknown };
  if (!envelope.success)
    throw Object.assign(new Error(JSON.stringify(envelope.errors)), {
      unityErrors: envelope.errors,
    });
  return envelope.data;
}

export async function projects(signal?: AbortSignal, target?: string): Promise<unknown> {
  const data = await cli(["projects"], signal, target ? await sshTarget(target) : undefined);
  return target ? { target, data } : data;
}

export async function editors(signal?: AbortSignal, targetId?: string): Promise<EditorInstance[]> {
  return discoverEditors(signal, targetId ? await sshTarget(targetId) : undefined);
}

export async function discoverAll(
  kind: "projects" | "editors",
  signal?: AbortSignal,
): Promise<
  { target: string; kind: "local" | "ssh" | "settings"; data?: unknown; error?: string }[]
> {
  const run = async (target?: SshTarget) => {
    try {
      const data =
        kind === "editors"
          ? await discoverEditors(signal, target)
          : await cli(["projects"], signal, target);
      return {
        kind: target ? ("ssh" as const) : ("local" as const),
        target: target?.id ?? "local",
        data,
      };
    } catch (error) {
      signal?.throwIfAborted();
      return {
        kind: target ? ("ssh" as const) : ("local" as const),
        target: target?.id ?? "local",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  let targets: SshTarget[];
  try {
    targets = await sshTargets();
  } catch (error) {
    signal?.throwIfAborted();
    return [
      await run(),
      {
        kind: "settings",
        target: "ssh-settings",
        error: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  return Promise.all([run(), ...targets.map((target) => run(target))]);
}
async function discoverEditors(
  signal?: AbortSignal,
  target?: SshTarget,
): Promise<EditorInstance[]> {
  let data: { instances: EditorInstance[]; partial?: boolean };
  try {
    data = (await cli(["status"], signal, target)) as {
      instances: EditorInstance[];
      partial?: boolean;
    };
  } catch (error) {
    const errors = (error as { unityErrors?: unknown }).unityErrors;
    if (
      Array.isArray(errors) &&
      errors.length === 1 &&
      (errors[0] as { code?: unknown } | undefined)?.code === "STATUS_NO_INSTANCES"
    )
      return [];
    throw error;
  }
  if (!Array.isArray(data.instances) || data.partial)
    throw new Error("Unity did not provide a complete editor list.");
  if (!target) return data.instances;
  return Promise.all(
    data.instances.map(async (instance: EditorInstance) => {
      let projectPath = instance.projectPath;
      if (/^[a-z]:[\\/]/i.test(projectPath) || projectPath.startsWith("\\\\")) {
        try {
          const { stdout } = await execFileAsync(
            "ssh",
            sshArguments(target, "wslpath", ["-u", projectPath]),
            { signal, timeout: 30000, maxBuffer: 65536, windowsHide: true },
          );
          projectPath = stdout.replace(/\r?\n$/, "");
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new Error(
            `Cannot convert a Windows project path on SSH target ${target.id}; run the CLI through WSL with wslpath available.`,
            { cause: error },
          );
        }
      }
      return { ...instance, projectPath: remoteProject(target.id, projectPath) };
    }),
  );
}

async function select(
  project: string,
  target: SshTarget | undefined,
  signal?: AbortSignal,
): Promise<EditorInstance> {
  const remote = parseRemoteProject(project);
  return selectEditor(
    remote ? remote.path : project,
    (await discoverEditors(signal, target)).map((instance) => {
      if (!remote) return instance;
      const instanceRemote = parseRemoteProject(instance.projectPath);
      if (!instanceRemote) throw new Error("Expected a remote editor project path.");
      return { ...instance, projectPath: instanceRemote.path };
    }),
  );
}

async function connect(
  project: string,
  signal?: AbortSignal,
): Promise<{ client: Client; target: EditorInstance; ssh: SshTarget | undefined }> {
  const remote = parseRemoteProject(project);
  const ssh = remote ? await sshTarget(remote.target) : undefined;
  const target = await select(project, ssh, signal);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
  delete env.UNITY_PROJECT_PATH;
  if (!ssh) env.PATH = localPath();
  const client = new Client({ name: "pi-agent-unity", version: "0.1.0" });
  const run = await invocation(["mcp", "--pid", String(target.pid)], ssh, signal);
  const transport = new StdioClientTransport({ ...run, env, stderr: "pipe" });
  if (transport.stderr instanceof Readable) transport.stderr.resume();
  let connected = false;
  try {
    await client.connect(transport, { signal, timeout: 30000 });
    connected = true;
    const current = await select(project, ssh, signal);
    if (current.pid !== target.pid || current.port !== target.port)
      throw new Error("The target editor changed while connecting; retry discovery.");
    return { client, target, ssh };
  } catch (error) {
    await client.close();
    if (ssh && !connected && !signal?.aborted)
      throw new Error(
        `Cannot start Unity MCP on SSH target ${ssh.id}. Check SSH access, Python 3, the remote Unity CLI, and that the selected Editor is still running.`,
        { cause: error },
      );
    throw error;
  }
}

export async function listTools(project: string, signal?: AbortSignal): Promise<unknown[]> {
  const { client } = await connect(project, signal);
  try {
    const tools: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: 30000,
      });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close();
  }
}

export async function callTool(
  project: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const { client, target, ssh } = await connect(project, signal);
  try {
    const current = await select(project, ssh, signal);
    if (current.pid !== target.pid || current.port !== target.port)
      throw new Error("The target editor changed; retry discovery.");
    return await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120000 });
  } finally {
    await client.close();
  }
}
