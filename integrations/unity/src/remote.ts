import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface SshTarget {
  id: string;
  host: string;
  workspace: string;
  configFile?: string;
}
const idPattern = /^[a-z0-9][a-z0-9_-]*$/;
const hostPattern = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function remoteProject(target: string, filePath: string): string {
  if (!idPattern.test(target) || !filePath.startsWith("/") || filePath.includes("\0"))
    throw new Error("Invalid SSH target or absolute project path.");
  return `ssh://${target}${path.posix.normalize(filePath).split("/").map(encodeURIComponent).join("/")}`;
}

export function parseRemoteProject(source: string): { target: string; path: string } | undefined {
  if (!source.startsWith("ssh:")) return undefined;
  const url = new URL(source);
  if (
    !source.startsWith("ssh://") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.port ||
    source.includes("?") ||
    source.includes("#")
  )
    throw new Error("Invalid SSH project path.");
  const filePath = decodeURIComponent(url.pathname);
  remoteProject(url.hostname, filePath);
  return { target: url.hostname, path: filePath };
}

async function scope(filename: string): Promise<(SshTarget | { id: string; unsupported: true })[]> {
  let source: string;
  try {
    source = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const data: unknown = JSON.parse(source);
    if (
      !data ||
      typeof data !== "object" ||
      Object.keys(data).some((k) => k !== "targets") ||
      !Array.isArray((data as { targets?: unknown }).targets)
    )
      throw new Error();
    const seen = new Set<string>();
    return (data as { targets: unknown[] }).targets.map(
      (value): SshTarget | { id: string; unsupported: true } => {
        if (!value || typeof value !== "object") throw new Error();
        const t = value as Record<string, unknown>;
        if (
          Object.keys(t).some(
            (k) => !["id", "host", "workspace", "configFile", "os"].includes(k),
          ) ||
          typeof t.id !== "string" ||
          typeof t.host !== "string" ||
          typeof t.workspace !== "string" ||
          (t.configFile !== undefined && (typeof t.configFile !== "string" || !t.configFile))
        )
          throw new Error();
        if (t.os !== undefined && t.os !== "linux" && t.os !== "windows") throw new Error();
        if (seen.has(t.id) || !hostPattern.test(t.host)) throw new Error();
        seen.add(t.id);
        // Native Windows targets serve Pi Agent IDE only; Unity reaches Windows editors through a Linux (WSL) target.
        if (t.os === "windows") return { id: t.id, unsupported: true };
        remoteProject(t.id, t.workspace);
        return {
          id: t.id,
          host: t.host,
          workspace: t.workspace,
          ...(typeof t.configFile === "string"
            ? { configFile: path.resolve(path.dirname(filename), t.configFile) }
            : {}),
        };
      },
    );
  } catch {
    throw new Error(`Invalid SSH settings at ${filename}`);
  }
}

export async function sshTargets(): Promise<SshTarget[]> {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const global = await scope(path.join(agentDir, "pi-agent-ide", "ssh.json"));
  const project = await scope(path.join(process.cwd(), ".pi", "pi-agent-ide", "ssh.json"));
  return [...global.filter((t) => !project.some((p) => p.id === t.id)), ...project].filter(
    (target): target is SshTarget => !("unsupported" in target),
  );
}

export async function sshTarget(id: string): Promise<SshTarget> {
  const target = (await sshTargets()).find((t) => t.id === id);
  if (!target) throw new Error(`SSH target ${id} is not configured in pi-agent-ide/ssh.json.`);
  return target;
}

export function sshArguments(
  target: SshTarget,
  command: string,
  args: string[],
  resolveUnity = false,
): string[] {
  remoteProject(target.id, target.workspace);
  if (!hostPattern.test(target.host)) throw new Error("Invalid SSH host alias.");
  // Only base64 enters the shell command. Python exec replaces itself with the CLI,
  // preserving stdin/stdout for MCP and preventing inherited target selection.
  const payload = Buffer.from(JSON.stringify([command, ...args])).toString("base64");
  const fallback =
    resolveUnity && command === "unity"
      ? String.raw`
import shutil,subprocess
if not shutil.which(a[0]):
 for candidate in ("~/.local/share/pi-agent-unity/bin/unity", "~/.local/bin/unity", "~/.unity/bin/unity"):
  candidate=os.path.expanduser(candidate)
  if os.path.isfile(candidate) and os.access(candidate,os.X_OK):
   a[0]=candidate
   break
if not shutil.which(a[0]) and shutil.which("wslpath"):
 try:
  sep=chr(92)
  root=os.environ.get("SystemRoot", "C:"+sep+"Windows")
  ps=shutil.which("powershell.exe") or subprocess.check_output(["wslpath","-u",root+sep+sep.join(["System32","WindowsPowerShell","v1.0","powershell.exe"])],text=True,timeout=5).strip()
  local=subprocess.check_output([ps,"-NoProfile","-NonInteractive","-Command","$env:LOCALAPPDATA"],text=True,timeout=10,stdin=subprocess.DEVNULL).strip()
  exe=subprocess.check_output(["wslpath","-u",local+sep+sep.join(["Unity","bin","unity.exe"])],text=True,timeout=5).strip()
  if local and os.path.isfile(exe) and os.access(exe,os.X_OK): a[0]=exe
 except (OSError,subprocess.SubprocessError): pass
`
      : "";
  const program = `import os,json,base64,sys\na=json.loads(base64.b64decode('${payload}'))\nos.environ.pop('UNITY_PROJECT_PATH',None)\n${fallback}\ntry:\n os.execvp(a[0],a)\nexcept FileNotFoundError:\n print('PI_UNITY_COMMAND_NOT_FOUND',file=sys.stderr)\n sys.exit(127)\nexcept PermissionError:\n print('PI_UNITY_COMMAND_INVALID',file=sys.stderr)\n sys.exit(126)`;
  const bootstrap = `python3 -c '${program.replaceAll("'", '"')}'`;
  const options = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ClearAllForwardings=yes",
  ];
  if (target.configFile) options.push("-F", target.configFile);
  return [...options, "--", target.host, bootstrap];
}
