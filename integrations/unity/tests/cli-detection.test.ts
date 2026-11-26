import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cli } from "#unity/backend.ts";
import { resetAutoInstall } from "#unity/auto-install.ts";
import { hostProbe } from "#unity/install.ts";
import { fakeInstallSh, installerServer } from "./installer-server.ts";

const realProbe = { ...hostProbe };

void test("SSH finds the Windows CLI through WSL when PowerShell is not on PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-wsl-"));
  const old = { ...process.env };
  try {
    await writeFile(
      path.join(root, "ssh"),
      '#!/bin/sh\nfor last do :; done\nexec /bin/sh -c "$last"\n',
      { mode: 0o755 },
    );
    const { symlink } = await import("node:fs/promises");
    await symlink("/usr/bin/python3", path.join(root, "python3"));
    await writeFile(
      path.join(root, "wslpath"),
      `#!/bin/sh\ncase "$2" in *Windows*) echo '${root}/system-powershell';; *) echo '${root}/unity.exe';; esac\n`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(root, "system-powershell"),
      "#!/bin/sh\necho C:\\Users\\tester\\AppData\\Local\n",
      { mode: 0o755 },
    );
    await writeFile(
      path.join(root, "unity.exe"),
      '#!/bin/sh\necho \'{"success":true,"data":{"instances":[]}}\'\n',
      { mode: 0o755 },
    );
    process.env.PATH = root;
    process.env.HOME = root;
    delete process.env.PI_UNITY_REMOTE_CLI;
    assert.deepEqual(
      await cli(["status"], undefined, { id: "studio", host: "fake", workspace: "/" }),
      { instances: [] },
    );
  } finally {
    process.env = old;
    await rm(root, { recursive: true, force: true });
  }
});
void test("local WSL discovers its Windows CLI when PowerShell is not on PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-local-wsl-"));
  const old = { ...process.env };
  try {
    hostProbe.osrelease = async () => "microsoft";
    await writeFile(
      path.join(root, "wslpath"),
      `#!/bin/sh\ncase "$2" in *Windows*) echo '${root}/system-powershell';; *) echo '${root}/unity.exe';; esac\n`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(root, "system-powershell"),
      "#!/bin/sh\necho C:\\Users\\tester\\AppData\\Local\n",
      { mode: 0o755 },
    );
    await writeFile(
      path.join(root, "unity.exe"),
      '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.2.3; else echo \'{"success":true,"data":{"instances":[]}}\'; fi\n',
      { mode: 0o755 },
    );
    process.env.PATH = root;
    process.env.HOME = root;
    delete process.env.PI_UNITY_CLI;
    assert.deepEqual(await cli(["status"]), { instances: [] });
  } finally {
    Object.assign(hostProbe, realProbe);
    process.env = old;
    await rm(root, { recursive: true, force: true });
  }
});
void test("a managed local CLI works even when its directory is not on PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-managed-"));
  const old = { ...process.env };
  try {
    const { mkdir } = await import("node:fs/promises");
    const directory = path.join(root, ".local/share/pi-agent-unity/bin");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "unity"),
      '#!/bin/sh\necho \'{"success":true,"data":{"instances":[]}}\'\n',
      { mode: 0o755 },
    );
    process.env.HOME = root;
    process.env.PATH = root;
    delete process.env.PI_UNITY_CLI;
    assert.deepEqual(await cli(["status"]), { instances: [] });
  } finally {
    process.env = old;
    await rm(root, { recursive: true, force: true });
  }
});
void test("editor discovery treats the CLI no-instances response as an empty list", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-no-instances-"));
  const old = { ...process.env };
  try {
    const executable = path.join(root, "unity");
    await writeFile(
      executable,
      `#!/bin/sh\necho '{"success":false,"errors":[{"code":"STATUS_NO_INSTANCES"}]}'\nexit 12\n`,
      { mode: 0o755 },
    );
    process.env.PI_UNITY_CLI = executable;
    const { editors } = await import("#unity/backend.ts");
    assert.deepEqual(await editors(), []);
  } finally {
    process.env = old;
    await rm(root, { recursive: true, force: true });
  }
});
void test("CLI errors retain the structured error returned with a nonzero exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-cli-error-"));
  const old = { ...process.env };
  try {
    const executable = path.join(root, "unity");
    await writeFile(
      executable,
      '#!/bin/sh\necho \'{"success":false,"errors":[{"code":"STATUS_NO_INSTANCES"}]}\'\nexit 12\n',
      { mode: 0o755 },
    );
    process.env.PI_UNITY_CLI = executable;
    await assert.rejects(cli(["status"]), (error: Error) => {
      try {
        return (
          (JSON.parse(error.message) as { code?: string }[])[0]?.code === "STATUS_NO_INSTANCES"
        );
      } catch {
        return false;
      }
    });
  } finally {
    process.env = old;
    await rm(root, { recursive: true, force: true });
  }
});
void test("missing and explicitly configured CLI are identified on the selected machine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-cli-check-"));
  const old = { ...process.env };
  try {
    process.env.PATH = root;
    process.env.HOME = root;
    process.env.PI_UNITY_AUTO_INSTALL = "0";
    delete process.env.PI_UNITY_CLI;
    await assert.rejects(
      cli(["status"]),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        "target" in error &&
        error.code === "UNITY_CLI_MISSING" &&
        error.target === "local" &&
        /PI_UNITY_AUTO_INSTALL/.test(error.message),
    );
    const nonExecutable = path.join(root, "non-executable");
    await writeFile(nonExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    process.env.PI_UNITY_CLI = nonExecutable;
    await assert.rejects(
      cli(["status"]),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        "target" in error &&
        error.code === "UNITY_CLI_INVALID" &&
        error.target === "local",
    );
    process.env.PI_UNITY_CLI = path.join(root, "configured-unity");
    await assert.rejects(
      cli(["status"]),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        "target" in error &&
        error.code === "UNITY_CLI_INVALID" &&
        error.target === "local",
    );
    // Use a POSIX shell to execute the actual SSH bootstrap locally.
    await writeFile(
      path.join(root, "ssh"),
      `#!/bin/sh\nfor last do :; done\nexec /bin/sh -c "$last"\n`,
      { mode: 0o755 },
    );
    // The bootstrap needs Python, but the target does not have Unity.
    const { symlink } = await import("node:fs/promises");
    await symlink("/usr/bin/python3", path.join(root, "python3"));
    delete process.env.PI_UNITY_REMOTE_CLI;
    const target = { id: "studio", host: "fake", workspace: "/" };
    await assert.rejects(
      cli(["status"], undefined, target),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        "target" in error &&
        error.code === "UNITY_CLI_MISSING" &&
        error.target === "studio",
    );
    process.env.PI_UNITY_REMOTE_CLI = "/missing/explicit-unity";
    await assert.rejects(
      cli(["status"], undefined, target),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        "target" in error &&
        error.code === "UNITY_CLI_INVALID" &&
        error.target === "studio",
    );
  } finally {
    process.env = old;
    await rm(root, { recursive: true, force: true });
  }
});

// Simulates only the host platform and the download of Unity's installer; the installer orchestration is real.
async function fakeInstallerHome(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const installer = [
    'mkdir -p "$UNITY_CLI_HOME/bin"',
    `cat > "$UNITY_CLI_HOME/bin/unity" <<'EOF'`,
    "#!/bin/sh",
    `if [ "$1" = --version ]; then echo 1.2.3; else echo '{"success":true,"data":{"instances":[]}}'; fi`,
    "EOF",
    'chmod +x "$UNITY_CLI_HOME/bin/unity"',
    "",
  ].join("\n");
  await writeFile(
    path.join(root, "sitecustomize.py"),
    `
import builtins, io, urllib.request
_real_open = builtins.open
def open_mock(path, *args, **kwargs):
    if path == '/proc/sys/kernel/osrelease': return io.StringIO('linux')
    return _real_open(path, *args, **kwargs)
builtins.open = open_mock
class Response:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, limit): return ${JSON.stringify(installer)}.encode()
urllib.request.urlopen = lambda *args, **kwargs: Response()
`,
  );
  return root;
}
void test("a missing local CLI is installed automatically and the request continues", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-auto-install-"));
  const old = { ...process.env };
  const server = await installerServer({ "install.sh": fakeInstallSh });
  try {
    resetAutoInstall();
    hostProbe.osrelease = async () => "linux";
    process.env.HOME = root;
    process.env.PATH = "/usr/bin:/bin";
    process.env.PI_UNITY_INSTALLER_BASE = server.base;
    delete process.env.PI_UNITY_CLI;
    delete process.env.PI_UNITY_AUTO_INSTALL;
    // Concurrent requests share one installation.
    const results = await Promise.all([cli(["status"]), cli(["projects"])]);
    assert.deepEqual(results, [{ instances: [] }, { instances: [] }]);
    assert.ok((await stat(path.join(root, ".local/share/pi-agent-unity/bin/unity"))).isFile());
    assert.deepEqual(await cli(["status"]), { instances: [] });
  } finally {
    await server.close();
    Object.assign(hostProbe, realProbe);
    process.env = old;
    resetAutoInstall();
    await rm(root, { recursive: true, force: true });
  }
});
void test("a missing CLI on an SSH target is installed automatically", async () => {
  const root = await fakeInstallerHome("unity-auto-install-ssh-");
  const old = { ...process.env };
  try {
    resetAutoInstall();
    await writeFile(
      path.join(root, "ssh"),
      '#!/bin/sh\nfor last do :; done\nexec /bin/sh -c "$last"\n',
      { mode: 0o755 },
    );
    // Expose only the tools the installer needs, so a WSL host's wslpath cannot lead to a real Windows CLI.
    const { symlink } = await import("node:fs/promises");
    for (const tool of ["python3", "mkdir", "cat", "chmod"])
      await symlink(`/usr/bin/${tool}`, path.join(root, tool));
    process.env.HOME = root;
    process.env.PYTHONPATH = root;
    process.env.PATH = root;
    delete process.env.PI_UNITY_REMOTE_CLI;
    delete process.env.PI_UNITY_AUTO_INSTALL;
    assert.deepEqual(
      await cli(["status"], undefined, { id: "studio", host: "fake", workspace: "/" }),
      { instances: [] },
    );
    assert.ok((await stat(path.join(root, ".local/share/pi-agent-unity/bin/unity"))).isFile());
  } finally {
    process.env = old;
    resetAutoInstall();
    await rm(root, { recursive: true, force: true });
  }
});
void test("a failed automatic installation explains why the CLI is still missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-auto-install-failed-"));
  const old = { ...process.env };
  try {
    resetAutoInstall();
    hostProbe.osrelease = async () => "linux";
    process.env.HOME = root;
    process.env.PATH = "/usr/bin:/bin";
    process.env.PI_UNITY_INSTALLER_BASE = "http://127.0.0.1:1/";
    delete process.env.PI_UNITY_CLI;
    delete process.env.PI_UNITY_AUTO_INSTALL;
    await assert.rejects(
      cli(["status"]),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "UNITY_CLI_MISSING" &&
        /Could not download .*install\.sh/.test(error.message),
    );
  } finally {
    Object.assign(hostProbe, realProbe);
    process.env = old;
    resetAutoInstall();
    await rm(root, { recursive: true, force: true });
  }
});
