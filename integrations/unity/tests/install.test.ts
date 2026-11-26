import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostProbe, inspectInstallation, installCli } from "#unity/install.ts";
import { fakeInstallSh, installerServer } from "./installer-server.ts";

const realProbe = { ...hostProbe };
/** Run a test with its own HOME, a clean environment and a simulated host, restoring everything afterwards. */
async function isolated(
  prefix: string,
  host: { platform?: string; arch?: string; osrelease?: string },
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const old = { ...process.env };
  try {
    hostProbe.platform = () => host.platform ?? "linux";
    hostProbe.arch = () => host.arch ?? "x64";
    hostProbe.osrelease = async () => host.osrelease ?? "linux";
    process.env.HOME = root;
    process.env.TMPDIR = root;
    process.env.PATH = "/usr/bin:/bin";
    for (const key of [
      "PI_UNITY_CLI",
      "PI_UNITY_REMOTE_CLI",
      "PI_UNITY_INSTALLER_BASE",
      "LOCALAPPDATA",
      "WSLENV",
    ])
      delete process.env[key];
    await body(root);
  } finally {
    Object.assign(hostProbe, realProbe);
    // Restore key by key: os.tmpdir() reads the real environment, which replacing process.env would not reset.
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    await rm(root, { recursive: true, force: true });
  }
}

void test("installation requires consent and never replaces an existing managed executable", () =>
  isolated("unity-install-", {}, async (root) => {
    assert.equal((await inspectInstallation()).state, "missing");
    await assert.rejects(installCli({ confirmed: false }));
    const file = path.join(root, ".local", "share", "pi-agent-unity", "bin", "unity");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "#!/bin/sh\necho version\n", { mode: 0o755 });
    assert.equal((await inspectInstallation()).state, "found");
    await assert.rejects(installCli({ confirmed: true }));
    assert.equal(await readFile(file, "utf8"), "#!/bin/sh\necho version\n");
  }));

for (const platform of ["linux", "darwin"]) {
  void test(`confirmed ${platform} installation verifies the downloaded CLI and links it without overwriting files`, () =>
    isolated(
      `unity-install-${platform}-`,
      { platform, arch: platform === "darwin" ? "arm64" : "x64" },
      async (root) => {
        const server = await installerServer({ "install.sh": fakeInstallSh });
        try {
          process.env.PI_UNITY_INSTALLER_BASE = server.base;
          const result = await installCli({ confirmed: true });
          assert.equal(result.state, "found");
          assert.equal(result.executable, path.join(root, ".local/share/pi-agent-unity/bin/unity"));
          assert.equal((await inspectInstallation()).executable, result.executable);
          // The installer's temporary home leaves nothing behind.
          assert.ok(result.executable);
          assert.deepEqual((await readdir(path.dirname(result.executable))).sort(), ["unity"]);
          await assert.rejects(installCli({ confirmed: true }));
        } finally {
          await server.close();
        }
      },
    ));
}

void test("a failed download is reported with its reason and installs nothing", () =>
  isolated("unity-install-offline-", {}, async (root) => {
    process.env.PI_UNITY_INSTALLER_BASE = "http://127.0.0.1:1/";
    await assert.rejects(
      installCli({ confirmed: true }),
      /Could not download http:\/\/127\.0\.0\.1:1\/install\.sh/,
    );
    assert.equal((await inspectInstallation()).state, "missing");
    await assert.rejects(stat(path.join(root, ".local/share/pi-agent-unity/bin/unity")));
  }));

void test("an installer that does not produce a working CLI is not linked into place", () =>
  isolated("unity-install-broken-", {}, async () => {
    const server = await installerServer({
      "install.sh": '#!/bin/sh\nmkdir -p "$UNITY_CLI_HOME/bin"\nexit 0\n',
    });
    try {
      process.env.PI_UNITY_INSTALLER_BASE = server.base;
      await assert.rejects(installCli({ confirmed: true }), /installation failed/);
      assert.equal((await inspectInstallation()).state, "missing");
    } finally {
      await server.close();
    }
  }));

// Fake Windows tooling for WSL and native Windows: only the OS commands are stand-ins.
async function fakeWindows(
  root: string,
  simulate: "wsl" | "windows",
): Promise<{ cli: string; log: string }> {
  const windowsCli = path.join(root, "AppData", "Unity", "bin", "unity.exe");
  const log = path.join(root, "powershell.log");
  const temp = path.join(root, "windows-temp");
  await mkdir(temp, { recursive: true });
  await writeFile(
    path.join(root, "powershell.exe"),
    `#!/bin/sh
case "$*" in
  *LOCALAPPDATA*) echo 'C:\\Users\\tester\\AppData\\Local' ;;
  *GetTempPath*) echo 'C:\\Users\\tester\\Temp\\' ;;
  *-File*)
    for last do :; done
    script="$last"
    [ "${simulate}" = wsl ] && script="${temp}/\${last##*\\\\}"
    [ -f "$script" ] || { echo "script missing: $script" >&2; exit 1; }
    head -c 3 "$script" | od -An -tx1 | grep -q 'ef bb bf' || { echo "no BOM" >&2; exit 1; }
    echo "skip=$UNITY_CLI_SKIP_SETUP wslenv=$WSLENV" > '${log}'
    mkdir -p '${path.dirname(windowsCli)}'
    printf '#!/bin/sh\\necho 1.2.3\\n' > '${windowsCli}'
    chmod +x '${windowsCli}'
    ;;
esac
`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(root, "wslpath"),
    `#!/bin/sh
case "$2" in
  *Unity*unity.exe) echo '${windowsCli}' ;;
  *Temp*) echo '${temp}' ;;
  *) echo "$2" ;;
esac
`,
    { mode: 0o755 },
  );
  return { cli: windowsCli, log };
}

void test("WSL installs the Windows CLI through PowerShell for Windows Editors", () =>
  isolated("unity-install-wsl-", { osrelease: "microsoft" }, async (root) => {
    const { cli, log } = await fakeWindows(root, "wsl");
    const server = await installerServer({ "install.ps1": "Write-Host installer\n" });
    try {
      process.env.PATH = `${root}:/usr/bin:/bin`;
      process.env.PI_UNITY_INSTALLER_BASE = server.base;
      const before = await inspectInstallation();
      assert.equal(before.state, "missing");
      const result = await installCli({ confirmed: true });
      assert.equal(result.state, "found");
      assert.equal(result.executable, cli);
      assert.match(await readFile(log, "utf8"), /skip=1 wslenv=UNITY_CLI_SKIP_SETUP/);
      assert.deepEqual(await readdir(path.join(root, "windows-temp")), []);
      await assert.rejects(installCli({ confirmed: true }));
    } finally {
      await server.close();
    }
  }));

void test("native Windows runs the official PowerShell installer and finds %LOCALAPPDATA%\\Unity\\bin", () =>
  isolated("unity-install-windows-", { platform: "win32" }, async (root) => {
    const { cli, log } = await fakeWindows(root, "windows");
    const server = await installerServer({ "install.ps1": "Write-Host installer\n" });
    try {
      process.env.PATH = `${root}:/usr/bin:/bin`;
      process.env.LOCALAPPDATA = path.join(root, "AppData");
      process.env.PI_UNITY_INSTALLER_BASE = server.base;
      const before = await inspectInstallation();
      assert.equal(before.state, "missing");
      assert.equal(before.destination, cli);
      const result = await installCli({ confirmed: true });
      assert.equal(result.state, "found");
      assert.equal(result.executable, cli);
      assert.match(await readFile(log, "utf8"), /skip=1/);
    } finally {
      await server.close();
    }
  }));

void test("inspection finds a Windows CLI in WSL without PowerShell on PATH", () =>
  isolated("unity-inspect-wsl-", { osrelease: "microsoft" }, async (root) => {
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
    await writeFile(path.join(root, "unity.exe"), "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });
    process.env.PATH = root;
    const info = await inspectInstallation();
    assert.equal(info.state, "found");
    assert.equal(info.executable, path.join(root, "unity.exe"));
  }));

void test("inspection finds the default Windows CLI outside PATH", () =>
  isolated("unity-inspect-windows-", { platform: "win32" }, async (root) => {
    await mkdir(path.join(root, "Unity", "bin"), { recursive: true });
    const executable = path.join(root, "Unity", "bin", "unity.exe");
    await writeFile(executable, "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });
    process.env.LOCALAPPDATA = root;
    const info = await inspectInstallation();
    assert.equal(info.state, "found");
    assert.equal(info.executable, executable);
  }));

void test("inspection finds the official macOS install directory", () =>
  isolated("unity-inspect-macos-", { platform: "darwin", arch: "arm64" }, async (root) => {
    await mkdir(path.join(root, ".unity", "bin"), { recursive: true });
    const executable = path.join(root, ".unity", "bin", "unity");
    await writeFile(executable, "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });
    assert.equal((await inspectInstallation()).executable, executable);
  }));

void test("local inspection reports a configured CLI, and an unsupported platform with manual guidance", () =>
  isolated("unity-inspect-unsupported-", {}, async (root) => {
    process.env.PI_UNITY_CLI = path.join(root, "missing-unity");
    assert.equal((await inspectInstallation()).state, "invalid");
    delete process.env.PI_UNITY_CLI;
    hostProbe.platform = () => "freebsd";
    const info = await inspectInstallation();
    assert.equal(info.state, "unsupported");
    assert.ok(info.detail);
    assert.match(info.detail, /https:\/\//);
    hostProbe.platform = () => "linux";
    hostProbe.arch = () => "ia32";
    assert.equal((await inspectInstallation()).state, "unsupported");
  }));

void test("a configured executable is not replaced by an install", () =>
  isolated("unity-install-configured-", {}, async () => {
    process.env.PI_UNITY_CLI = "/definitely/missing/custom-unity";
    assert.equal((await inspectInstallation()).state, "invalid");
    await assert.rejects(installCli({ confirmed: true }));
  }));

void test("cancelled remote installation reports an unknown effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-install-abort-"));
  const old = { ...process.env };
  try {
    await writeFile(path.join(root, "ssh"), "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
    process.env.PATH = root;
    delete process.env.PI_UNITY_REMOTE_CLI;
    const controller = new AbortController();
    const pending = installCli({
      confirmed: true,
      target: { id: "studio", host: "fake", workspace: "/" },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /unknown.*inspect before retrying/i);
  } finally {
    process.env = old;
    await rm(root, { recursive: true, force: true });
  }
});
void test("a failed SSH transport is not a missing CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unity-install-ssh-"));
  const old = { ...process.env };
  try {
    await writeFile(path.join(root, "ssh"), "#!/bin/sh\nexit 255\n", { mode: 0o755 });
    process.env.PATH = `${root}:/usr/bin:/bin`;
    delete process.env.PI_UNITY_REMOTE_CLI;
    await assert.rejects(inspectInstallation({ id: "offline", host: "offline", workspace: "/" }));
  } finally {
    process.env = old;
    await rm(root, { recursive: true, force: true });
  }
});
