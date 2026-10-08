import { cp, readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { remoteLocation } from "#src/backend/identity.js";
import { startSshDapTransport } from "#src/backend/dap-transport.js";
import { startSshTcpDapTransport } from "#src/backend/dap-tcp-transport.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { DapClient } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";
import { createSshDebuggerWorkspaceOwner } from "#src/backend/debugger-workspace-owner.js";

test("remote DAP streams drain stderr, retain their owner and stop only their native channel", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const owner = registry.resolve(scope);
  if (!owner) throw new Error("Missing owner");
  const script = `${scope}/dap-owner-server.py`;
  try {
    await owner.backend.write(
      script.slice("ssh://fixture".length),
      await readFile("tests/integration/fixtures/dap-owner-server.py"),
      null,
    );
    const transport = await startSshDapTransport(registry, scope, {
      command: "python3",
      args: [`${fixture.workspace}/dap-owner-server.py`],
    });
    const client = DapClient.fromTransport(transport);
    try {
      const [metadata] = await readSshProcessMetadata(registry, scope, transport.remote.pid);
      expect(transport.remote).toMatchObject({ target: "fixture", identity: metadata?.identity });
      const body = {
        source: { path: `${fixture.workspace}/café.py` },
        text: "file:///source text is not a URI field",
      };
      await expect(client.request("initialize", body, { timeoutMs: 5000 })).resolves.toEqual(body);
      const controller = new AbortController();
      const pending = client.request("pending", {}, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow(/aborted/u);
    } finally {
      await client.dispose();
    }
    await expect(
      readSshProcessMetadata(registry, scope, transport.remote.pid),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      startSshDapTransport(registry, "ssh://unknown/tmp", { command: "python3", args: [] }),
    ).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
  } finally {
    await fixture.stop();
  }
}, 15000);

test("existing stdio recipes select target overrides and send only native launch paths", async () => {
  const fixture = await startSshFixture(
    { "owned-dap": "tests/integration/fixtures/dap-owner-server.py" },
    {
      PI_DART_PATH: "owned-dap",
      PI_KOTLIN_DEBUG_ADAPTER_PATH: "owned-dap",
      PI_NETCOREDBG_PATH: "owned-dap",
      PI_ELIXIR_LS_DEBUG_PATH: "owned-dap",
      PI_LLDB_DAP_PATH: "owned-dap",
    },
  );
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const owner = createSshDebuggerWorkspaceOwner(registry)(scope);
  if (!owner) throw new Error("Missing debugger owner");
  try {
    for (const adapter of ["dart", "kotlin", "netcoredbg", "elixir", "lldb-dap"] as const) {
      const prepared = await owner.prepare({
        adapter,
        program: `${scope}/note`,
        sourceFile: `${scope}/note`,
        cwd: scope,
        args: ["café", "ssh://source-text/not-a-path"],
        mainClass: "OwnedMain",
      });
      try {
        await prepared.client.request("initialize", {}, { timeoutMs: 5000 });
        const echoed = await prepared.client.request("launch", prepared.launch, {
          timeoutMs: 5000,
        });
        expect(echoed).toEqual(prepared.launch);
        expect(prepared.launch).toMatchObject(
          adapter === "elixir"
            ? {
                projectDir: fixture.workspace,
                taskArgs: [`${fixture.workspace}/note`, "café", "ssh://source-text/not-a-path"],
              }
            : {
                program: `${fixture.workspace}/note`,
                cwd: fixture.workspace,
                args: ["café", "ssh://source-text/not-a-path"],
              },
        );
        if (!prepared.remote) throw new Error("Missing target adapter identity");
        const [metadata] = await readSshProcessMetadata(registry, scope, prepared.remote.pid);
        expect(metadata?.command).toContain("owned-dap");
        if (adapter === "dart") expect(metadata?.command).toContain("debug_adapter");
        if (adapter === "netcoredbg") expect(metadata?.command).toContain("--interpreter=vscode");
        if (adapter === "kotlin")
          expect(prepared.launch).toMatchObject({
            mainClass: "OwnedMain",
            projectRoot: fixture.workspace,
          });
      } finally {
        await prepared.client.dispose();
      }
    }
  } finally {
    await fixture.stop();
  }
}, 30000);
test("PowerShell stdio uses target paths and removes only its private session directory", async () => {
  const fixture = await startSshFixture(
    { "owned-pwsh": "tests/integration/fixtures/dap-owner-server.py" },
    { PI_PWSH_PATH: "owned-pwsh", PI_POWERSHELL_EDITOR_SERVICES_PATH: "{workspace}/services-café" },
  );
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const owner = createSshDebuggerWorkspaceOwner(registry)(scope);
  const backend = registry.resolve(scope)?.backend;
  if (!owner || !backend) throw new Error("Missing debugger owner");
  try {
    const prepared = await owner.prepare({
      adapter: "powershell",
      cwd: scope,
      program: `${scope}/note-café.ps1`,
      sourceFile: `${scope}/note-café.ps1`,
      args: ["literal 'café'"],
    });
    let directory: string | undefined;
    try {
      await prepared.client.request("initialize", {}, { timeoutMs: 5000 });
      const args = await prepared.client.request<{ args: string[] }>("peerArguments", {});
      const command = args.args[args.args.indexOf("-Command") + 1];
      expect(command).toContain(
        `${fixture.workspace}/services-café/PowerShellEditorServices/Start-EditorServices.ps1`,
      );
      expect(command).toContain("-Stdio -DebugServiceOnly");
      const sessionFile = /-SessionDetailsPath '([^']+)'/u.exec(command ?? "")?.[1];
      if (!sessionFile) throw new Error("Missing private session path");
      directory = sessionFile.slice(0, sessionFile.lastIndexOf("/"));
      expect(directory).toMatch(/^\/tmp\/pi-agent-ide-powershell-/u);
      expect((await backend.stat(directory)).kind).toBe("directory");
      expect(prepared.launch).toMatchObject({
        script: `${fixture.workspace}/note-café.ps1`,
        cwd: fixture.workspace,
        args: ["literal 'café'"],
      });
    } finally {
      await prepared.client.dispose();
    }
    if (!directory) throw new Error("Missing created session directory");
    await expect(backend.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fixture.stop();
  }
}, 15000);
test("node-backed stdio recipes use target script and runtime paths", async () => {
  const fixture = await startSshFixture(
    { node: "tests/integration/fixtures/dap-owner-server.py" },
    {
      PI_PHP_DEBUG_PATH: "{workspace}/php-café.js",
      PI_PHP_PATH: "/native/php-café",
      PI_LUA_DEBUG_PATH: "{workspace}/lua-extension/extension/debugAdapter.js",
      PI_LUA_PATH: "/native/lua-café",
      PI_BASH_DEBUG_ROOT: "{workspace}/bash-extension",
      PI_BASH_DEBUG_PATH: "{workspace}/bash-café.js",
      PI_BASH_PATH: "/native/bash-café",
    },
  );
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const owner = createSshDebuggerWorkspaceOwner(registry)(scope);
  if (!owner) throw new Error("Missing debugger owner");
  try {
    for (const adapter of ["php", "lua", "shell"] as const) {
      const prepared = await owner.prepare({
        adapter,
        cwd: scope,
        program: `${scope}/note`,
        sourceFile: `${scope}/note`,
        args: ["café", "literal {port}"],
      });
      try {
        await prepared.client.request("initialize", {}, { timeoutMs: 5000 });
        expect(
          await prepared.client.request("launch", prepared.launch, { timeoutMs: 5000 }),
        ).toEqual(prepared.launch);
        expect(prepared.launch).toMatchObject({
          cwd: fixture.workspace,
          args: ["café", "literal {port}"],
        });
        if (!prepared.remote) throw new Error("Missing owning channel");
        const [metadata] = await readSshProcessMetadata(registry, scope, prepared.remote.pid);
        const script =
          adapter === "php"
            ? `${fixture.workspace}/php-café.js`
            : adapter === "lua"
              ? `${fixture.workspace}/lua-extension/extension/debugAdapter.js`
              : `${fixture.workspace}/bash-café.js`;
        expect(metadata?.command).toContain(script);
        if (adapter === "php")
          expect(prepared.launch).toMatchObject({
            runtimeExecutable: "/native/php-café",
            hostname: "127.0.0.1",
            port: 0,
            env: { XDEBUG_CONFIG: "client_port=${port}" },
          });
        if (adapter === "lua")
          expect(prepared.launch).toMatchObject({
            program: { lua: "/native/lua-café", file: `${fixture.workspace}/note` },
            extensionPath: `${fixture.workspace}/lua-extension`,
            workspacePath: fixture.workspace,
          });
        if (adapter === "shell")
          expect(prepared.launch).toMatchObject({
            pathBash: "/native/bash-café",
            pathBashdb: `${fixture.workspace}/bash-extension/bashdb_dir/bashdb`,
            pathBashdbLib: `${fixture.workspace}/bash-extension/bashdb_dir`,
            program: `${fixture.workspace}/note`,
          });
      } finally {
        await prepared.client.dispose();
      }
    }
  } finally {
    await fixture.stop();
  }
}, 30000);
test("TCP-only recipes keep their adapter and listener on the selected target", async () => {
  const peer = "tests/integration/fixtures/dap-owner-tcp-server.py";
  const fixture = await startSshFixture({
    dlv: peer,
    rdbg: peer,
    julia: peer,
    "owned-stdio-peer": "tests/integration/fixtures/dap-owner-server.py",
  });
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const owner = createSshDebuggerWorkspaceOwner(registry)(scope);
  if (!owner) throw new Error("Missing debugger owner");
  try {
    for (const adapter of ["delve", "ruby", "julia"] as const) {
      const prepared = await owner.prepare({
        adapter,
        cwd: scope,
        program: `${scope}/note`,
        sourceFile: `${scope}/note`,
        args: ["café", "{port}"],
      });
      let peerPid: number | undefined;
      try {
        if (!prepared.remote) throw new Error("Missing owning transport");
        await prepared.client.request("initialize", {}, { timeoutMs: 5000 });
        const peerIdentity = await prepared.client.request<{ pid: number }>(
          "peerPid",
          {},
          { timeoutMs: 5000 },
        );
        peerPid = peerIdentity.pid;
        const [metadata] = await readSshProcessMetadata(registry, scope, peerPid);
        expect(metadata?.parentPid).toBe(prepared.remote.pid);
        expect(
          await prepared.client.request("launch", prepared.launch, { timeoutMs: 5000 }),
        ).toEqual(prepared.launch);
        expect(prepared.launch).toMatchObject({
          program: `${fixture.workspace}/note`,
          cwd: fixture.workspace,
          args: ["café", "{port}"],
        });
        if (adapter === "ruby") expect(metadata?.command).toContain("café {port}");
      } finally {
        await prepared.client.dispose();
      }
      await expect(readSshProcessMetadata(registry, scope, peerPid)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readSshProcessMetadata(registry, scope, prepared.remote.pid),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await fixture.stop();
  }
}, 30000);
test("cancellation before TCP readiness stops both owned target processes", async () => {
  const fixture = await startSshFixture(
    {
      dlv: "tests/integration/fixtures/dap-owner-tcp-server.py",
      "owned-stdio-peer": "tests/integration/fixtures/dap-owner-server.py",
    },
    { PI_IDE_DAP_PEER_DELAY: "5", PI_IDE_DAP_PEER_PIDFILE: "{workspace}/peer-pid" },
  );
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const owner = registry.resolve(scope);
  if (!owner) throw new Error("Missing target");
  const controller = new AbortController();
  try {
    const transport = await startSshTcpDapTransport(registry, scope, {
      kind: "delve",
      program: `${fixture.workspace}/note`,
      args: [],
      signal: controller.signal,
    });
    try {
      const selected = await owner.backend.execute(
        "python3",
        [
          "-c",
          "import os,sys,time; p=sys.argv[1]; deadline=time.monotonic()+3\nwhile not os.path.exists(p) and time.monotonic()<deadline: time.sleep(0.025)\nprint(open(p,encoding='ascii').read())",
          `${fixture.workspace}/peer-pid`,
        ],
        fixture.workspace,
      );
      expect(selected.exitCode).toBe(0);
      const pid = Number(selected.stdout.toString("utf8"));
      expect(Number.isSafeInteger(pid)).toBe(true);
      controller.abort();
      await expect(transport.completion).rejects.toMatchObject({ code: "CANCELLED" });
      await expect(
        readSshProcessMetadata(registry, scope, transport.remote.pid),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readSshProcessMetadata(registry, scope, pid)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await expect(transport.stop()).resolves.toBeUndefined();
      // Physical cleanup does not turn the cancelled operation into a success.
      if (controller.signal.aborted)
        await expect(transport.completion).rejects.toMatchObject({ code: "CANCELLED" });
    }
  } finally {
    await fixture.stop();
  }
}, 15000);
test("another listener PID receives no DAP input from the selected adapter", async () => {
  const fixture = await startSshFixture(
    {
      dlv: "tests/integration/fixtures/dap-other-pid-listener.py",
      "owned-tcp-peer": "tests/integration/fixtures/dap-owner-tcp-server.py",
      "owned-stdio-peer": "tests/integration/fixtures/dap-owner-server.py",
    },
    {
      PI_IDE_DAP_PEER_RECEIVED: "{workspace}/received",
      PI_IDE_DAP_PEER_PIDFILE: "{workspace}/peer-pid",
    },
  );
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const owner = registry.resolve(scope);
  if (!owner) throw new Error("Missing target");
  try {
    const transport = await startSshTcpDapTransport(registry, scope, {
      kind: "delve",
      program: `${fixture.workspace}/note`,
      args: [],
    });
    const client = DapClient.fromTransport(transport);
    try {
      await expect(client.request("initialize", {}, { timeoutMs: 500 })).rejects.toThrow(
        "Timed out waiting for debug response initialize",
      );
      const selected = await owner.backend.execute(
        "python3",
        [
          "-c",
          "import os,sys,time; p=sys.argv[1]; deadline=time.monotonic()+3\nwhile not os.path.exists(p) and time.monotonic()<deadline: time.sleep(0.025)\nprint(open(p,encoding='ascii').read())",
          `${fixture.workspace}/peer-pid`,
        ],
        fixture.workspace,
      );
      expect(selected.exitCode).toBe(0);
      const pid = Number(selected.stdout.toString("utf8"));
      const [metadata] = await readSshProcessMetadata(registry, scope, pid);
      expect(metadata?.parentPid).not.toBe(transport.remote.pid);
      await expect(owner.backend.stat(`${fixture.workspace}/received`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await client.dispose();
    }
  } finally {
    await fixture.stop();
  }
}, 15000);
const lldbExecutable = process.env.PI_IDE_LLDB_DAP;
test.skipIf(!lldbExecutable).each([
  { language: "C", extension: "c", compiler: "gcc", flags: ["-g", "-O0"], line: 5 },
  { language: "C++", extension: "cpp", compiler: "g++", flags: ["-g", "-O0"], line: 5 },
  {
    language: "Rust",
    extension: "rs",
    compiler: "rustc",
    flags: ["-g", "-C", "opt-level=0"],
    line: 4,
  },
])(
  "real target LLDB stops at an owned $language source and evaluates its frame",
  async ({ extension, compiler, flags, line }) => {
    if (!lldbExecutable) throw new Error("Missing explicit LLDB executable");
    // Keep the explicit installation path so LLDB can find its adjacent native server.
    const fixture = await startSshFixture({}, { PI_LLDB_DAP_PATH: lldbExecutable });
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const scope = `ssh://fixture${fixture.workspace}`;
    const owner = registry.resolve(scope);
    if (!owner) throw new Error("Missing source owner");
    const manager = new DebugSessionManager(createSshDebuggerWorkspaceOwner(registry));
    try {
      const source = `${fixture.workspace}/note.${extension}`;
      const program = `${fixture.workspace}/note`;
      const code =
        extension === "rs"
          ? "fn main() {\n  let mut value: i32 = 42;\n  let pid = std::process::id();\n  value += 1;\n  std::process::exit(value);\n}\n"
          : "#include <unistd.h>\nint main(void) {\n  int value = 42;\n  int pid = getpid();\n  value += 1;\n  return value;\n}\n";
      await owner.backend.write(source, Buffer.from(code), null);
      const build = await owner.backend.execute(
        compiler,
        [...flags, source, "-o", program],
        fixture.workspace,
      );
      expect(build.exitCode, build.stderr.toString("utf8")).toBe(0);
      const resource = remoteLocation("fixture", source).source;
      const session = manager.create({
        adapter: "lldb-dap",
        cwd: scope,
        program: remoteLocation("fixture", program).source,
        sourceFile: resource,
        args: [],
      });
      await manager.addBreakpoint(manager.sourceResource(session), line);
      await manager.start(session);
      expect(session.status).toBe("stopped");
      expect(session.stop?.frame?.source?.path).toBe(resource);
      expect([...session.breakpoints.values()][0]?.verified).toBe(true);
      expect((await manager.evaluate(session, "value")).result).toMatch(/ = 42$/u);
      const pidResult = (await manager.evaluate(session, "pid")).result;
      const debuggeePid = Number(/ = (\d+)$/u.exec(pidResult)?.[1]);
      expect(Number.isSafeInteger(debuggeePid)).toBe(true);
      await manager.command(session, "next");
      expect((await manager.evaluate(session, "value")).result).toMatch(/ = 43$/u);
      await manager.delete(session.source);
      expect(manager.list()).toEqual([]);
      await expect(readSshProcessMetadata(registry, scope, debuggeePid)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await manager.dispose();
      await fixture.stop();
    }
  },
  30000,
);
// This optional test copies an explicitly supplied installed package into its private target.
const debugpyPackage = process.env.PI_IDE_DEBUGPY_PACKAGE;
test.skipIf(!debugpyPackage)(
  "real target debugpy stops at an owned source breakpoint and evaluates its frame",
  async () => {
    const fixture = await startSshFixture({}, { PYTHONPATH: "{workspace}/packages" });
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const scope = `ssh://fixture${fixture.workspace}`;
    const owner = registry.resolve(scope);
    if (!owner) throw new Error("Missing owner");
    const manager = new DebugSessionManager(createSshDebuggerWorkspaceOwner(registry));
    try {
      if (!debugpyPackage) throw new Error("Missing explicit debugpy package");
      await cp(debugpyPackage, `${fixture.workspace}/packages/debugpy`, { recursive: true });
      const program = `${fixture.workspace}/debug-café.py`;
      await owner.backend.write(
        program,
        Buffer.from('label = "café"\nprint(label)\nprint("done")\n'),
        null,
      );
      const resource = remoteLocation("fixture", program).source;
      const session = manager.create({
        adapter: "debugpy",
        program: resource,
        cwd: scope,
        args: [],
      });
      await expect(manager.readSource(manager.sourceResource(session))).resolves.toContain(
        'label = "café"',
      );
      await manager.addBreakpoint(manager.sourceResource(session), 2);
      await manager.start(session);
      expect(session.status).toBe("stopped");
      expect(session.stop?.frame?.source?.path).toBe(resource);
      expect(session.stop?.sourceLines[0]?.content).toBe('label = "café"');
      expect([...session.breakpoints.values()][0]?.verified).toBe(true);
      expect(manager.snapshot(session).remote).toMatchObject({ target: "fixture" });
      expect((await manager.evaluate(session, "label")).result).toContain("café");
      const debuggeePid = Number(
        (await manager.evaluate(session, "__import__('os').getpid()")).result,
      );
      expect(Number.isSafeInteger(debuggeePid)).toBe(true);
      const generation = session.stopGeneration;
      await manager.command(session, "next");
      expect(session.stopGeneration).toBeGreaterThan(generation);
      expect(session.stop?.frame?.line).toBe(3);
      await manager.delete(session.source);
      expect(manager.list()).toEqual([]);
      await expect(readSshProcessMetadata(registry, scope, debuggeePid)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      try {
        await manager.dispose();
      } finally {
        await fixture.stop();
      }
    }
  },
  30000,
);
