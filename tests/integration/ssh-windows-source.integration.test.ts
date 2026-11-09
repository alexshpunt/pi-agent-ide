import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import { SshBackend } from "#src/backend/ssh.ts";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

// Explicit opt-in: a native Windows Pi session against a real Linux host. It installs nothing and
// removes the temporary directory it creates under /tmp on the host.
const host = process.env.PI_IDE_SSH_LINUX_HOST;

test.skipIf(process.platform !== "win32" || !host)(
  "native Windows Pi works with a Linux SSH target: transfers with Windows paths and remote_bash only",
  async () => {
    if (!host) throw new Error("Set PI_IDE_SSH_LINUX_HOST to a trusted Linux SSH alias");
    const base = path.resolve(".tmp/ssh-windows-source-tests");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    const remoteDirectory = `/tmp/pi-ide-win-source-${randomBytes(6).toString("hex")}`;
    const remoteRoot = `ssh://linux${remoteDirectory}`;
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = path.join(cwd, "upload.bin");
    const downloadBackslash = path.join(cwd, "download-backslash.bin");
    const downloadSlash = path.join(cwd, "download-slash.bin").replaceAll("\\", "/");
    const cleanup = new SshBackend({ id: "cleanup", host, workspace: "/tmp" });
    try {
      const created = await cleanup.execute("mkdir", ["-p", "--", remoteDirectory], "/tmp");
      expect(created.exitCode).toBe(0);
      await writeFile(upload, bytes);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({
          noAnimations: true,
          noPostProcessing: true,
          disabled: [
            "ide.ast",
            "ide.lsp",
            "ide.formatter",
            "ide.lint",
            "ide.changes",
            "ide.diagnostics",
            "ide.debugger",
          ],
        }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
        JSON.stringify({
          targets: [
            { id: "linux", host, workspace: "/tmp" },
            { id: "win", host: "unused-windows-host", workspace: "C:/Users/unused", os: "windows" },
          ],
        }),
      );
      const call = (id: string, name: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name, arguments: args })]);
      const run = await new PiIntegrationTest({
        testName: "ssh-windows-source",
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts")],
        tools: ["read", "write", "copy", "delete", "powershell", "remote_bash"],
        timeoutMs: 180_000,
        conversation: [
          call("mkdir", "remote_bash", {
            command: "uname -s && pwd",
            cwd: remoteRoot,
          }),
          call("upload", "copy", { path: upload, target: `${remoteRoot}/upload.bin` }),
          call("remote-hash", "remote_bash", {
            command: "sha256sum upload.bin && stat -c %s upload.bin",
            cwd: remoteRoot,
          }),
          call("download-backslash", "copy", {
            path: `${remoteRoot}/upload.bin`,
            target: downloadBackslash,
          }),
          call("download-slash", "copy", {
            path: `${remoteRoot}/upload.bin`,
            target: downloadSlash,
          }),
          call("write-remote", "write", {
            path: `${remoteRoot}/note.txt`,
            content: "line one\nline two\n",
          }),
          call("read-remote", "read", { path: `${remoteRoot}/note.txt` }),
          call("list-remote", "read", { path: remoteRoot }),
          call("windows-cwd", "remote_bash", {
            command: "echo MUST-NOT-RUN",
            cwd: "ssh://win/C:/x",
          }),
          call("local-cwd", "remote_bash", { command: "echo MUST-NOT-RUN", cwd }),
          call("no-cwd", "remote_bash", { command: "echo MUST-NOT-RUN" }),
          call("powershell-linux", "powershell", {
            command: "echo MUST-NOT-RUN",
            cwd: remoteRoot,
          }),
          call("local-powershell", "powershell", { command: "$PSVersionTable.PSVersion.Major" }),
          assistantMessage([text("Windows source check complete.")]),
        ],
      }).run("Exercise a Linux SSH target from native Windows.");

      expect(getToolResultText(run, "mkdir")).toContain("Linux");
      expect(getToolExecution(run, "upload").isError).toBe(false);
      const remoteHash = getToolResultText(run, "remote-hash");
      expect(remoteHash).toContain(sha256);
      expect(remoteHash).toContain(String(bytes.length));
      for (const [id, file] of [
        ["download-backslash", downloadBackslash],
        ["download-slash", downloadSlash],
      ] as const) {
        expect(getToolExecution(run, id).isError, id).toBe(false);
        expect((await readFile(file)).equals(bytes), id).toBe(true);
      }
      expect(getToolExecution(run, "write-remote").isError).toBe(false);
      expect(getToolResultText(run, "read-remote")).toContain("line two");
      expect(getToolResultText(run, "list-remote")).toContain("upload.bin");

      expect(getToolExecution(run, "windows-cwd").isError).toBe(true);
      expect(getToolResultText(run, "windows-cwd")).toContain("is a Windows target");
      expect(getToolExecution(run, "local-cwd").isError).toBe(true);
      expect(getToolResultText(run, "local-cwd")).toContain("runs only on SSH targets");
      expect(getToolExecution(run, "no-cwd").isError).toBe(true);
      expect(getToolExecution(run, "powershell-linux").isError).toBe(true);
      expect(getToolResultText(run, "powershell-linux")).toContain("Use remote_bash");
      expect(getToolExecution(run, "local-powershell").isError).toBe(false);
      for (const id of ["windows-cwd", "local-cwd", "no-cwd", "powershell-linux"])
        expect(getToolResultText(run, id)).not.toContain("MUST-NOT-RUN\n");

      const request = JSON.stringify(run.providerRequests[0]);
      expect(request).toContain('"remote_bash"');
      expect(request).toContain('"powershell"');
    } finally {
      await cleanup.execute("rm", ["-rf", "--", remoteDirectory], "/tmp").catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  },
  240_000,
);
