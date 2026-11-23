import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { DapClient } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.ts";
import { LINUX_SSH_DEBUG_BROKERS } from "#src/plugins/pi-agent-ide-debugger/src/catalog.ts";
import {
  WINDOWS_SSH_ELIXIR_DEBUG_COMMAND,
  WINDOWS_SSH_LUA_DEBUG_PATH,
  WINDOWS_SSH_PHP_DEBUG_PATH,
} from "#src/plugins/pi-agent-ide-debugger/src/adapter-executables.ts";
import type { DebugWorkspaceOwnerResolver } from "#src/plugins/pi-agent-ide-debugger/src/workspace-owner.ts";
import type { SshBackendRegistry } from "./registry.ts";
import { remoteLocation, type SshTargetOs } from "./identity.ts";
import { sshNativePath } from "./native-path.ts";
import { remotePython, targetOs } from "./ssh-transport.ts";
import { SshBackendError, type SshBackend } from "./ssh.ts";
import { startSshDapTransport } from "./dap-transport.ts";
import { startSshTcpDapTransport } from "./dap-tcp-transport.ts";
import { prepareSshNodeDebugger } from "./dap-node-transport.ts";
import { prepareSshJavaDebugger } from "./dap-java-transport.ts";
import type { DebugSessionOptions } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.ts";
import { packagedSource } from "./packaged-source.ts";
import { resolveSshDebuggerExecutable } from "./dap-executables.ts";

const rWorker = packagedSource(new URL("./dap-r-worker.py", import.meta.url));
const powershellWorker = packagedSource(new URL("./dap-powershell-worker.py", import.meta.url));

const linuxBrokers = new Set(LINUX_SSH_DEBUG_BROKERS.values());

type StdioRecipe = {
  readonly command: string;
  readonly overrides: readonly string[];
  readonly args: readonly string[];
  readonly adapterID: string;
  readonly launch: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly dependency?: string;
};

const nodePathsSchema = Type.Object(
  {
    phpDebug: Type.String(),
    php: Type.String(),
    luaDebug: Type.String(),
    lua: Type.String(),
    bashRoot: Type.String(),
    bashDebug: Type.Union([Type.String(), Type.Null()]),
    bash: Type.String(),
  },
  { additionalProperties: false },
);

async function nodeStdioRecipe(
  backend: SshBackend,
  options: DebugSessionOptions,
  program: string,
  cwd: string,
  project: string,
  os: SshTargetOs,
  signal?: AbortSignal,
): Promise<StdioRecipe> {
  const pathOps = os === "windows" ? path.win32 : path.posix;
  const selections = {
    phpDebug: [
      "PI_PHP_DEBUG_PATH",
      os === "windows"
        ? WINDOWS_SSH_PHP_DEBUG_PATH
        : "/opt/pi-debug-adapters/php-debug/extension/out/phpDebug.js",
    ],
    php: ["PI_PHP_PATH", "php"],
    luaDebug: [
      "PI_LUA_DEBUG_PATH",
      os === "windows"
        ? WINDOWS_SSH_LUA_DEBUG_PATH
        : "/opt/pi-debug-adapters/lua-debug/extension/extension/debugAdapter.js",
    ],
    lua: ["PI_LUA_PATH", "lua"],
    bashRoot: ["PI_BASH_DEBUG_ROOT", "/opt/pi-debug-adapters/bash-debug/extension"],
    bashDebug: ["PI_BASH_DEBUG_PATH", null],
    bash: ["PI_BASH_PATH", "/usr/bin/bash"],
  };
  // Read only known adapter executable paths, never the controller's environment.
  const result = await backend.execute(
    remotePython(
      "import json,os,sys; fields=json.loads(sys.argv[1]); print(json.dumps({k:os.environ.get(v[0],v[1]) for k,v in fields.items()}))",
    ),
    [JSON.stringify(selections)],
    project,
    { signal },
  );
  if (result.exitCode !== 0)
    throw new SshBackendError("DEPENDENCY_UNAVAILABLE", options.program, "not-applied");
  let selected: unknown;
  try {
    selected = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new SshBackendError("INVALID_RESPONSE", options.program, "not-applied");
  }
  if (!Value.Check(nodePathsSchema, selected))
    throw new SshBackendError("INVALID_RESPONSE", options.program, "not-applied");
  const common = {
    name: "Pi Agent IDE debug session",
    request: "launch",
    program,
    cwd,
    args: [...options.args],
  };
  if (options.adapter === "php")
    return {
      command: "node",
      overrides: [],
      args: [selected.phpDebug],
      files: [selected.phpDebug],
      dependency: "Node and vscode-php-debug (PI_PHP_DEBUG_PATH)",
      adapterID: "php",
      launch: {
        ...common,
        type: "php",
        runtimeExecutable: selected.php,
        runtimeArgs: ["-dxdebug.start_with_request=yes"],
        console: "internalConsole",
        hostname: "127.0.0.1",
        port: 0,
        env: { XDEBUG_MODE: "debug,develop", XDEBUG_CONFIG: "client_port=${port}" },
      },
    };
  if (options.adapter === "lua")
    return {
      command: "node",
      overrides: [],
      args: [selected.luaDebug],
      files: [selected.luaDebug],
      dependency: "Node and local-lua-debugger-vscode (PI_LUA_DEBUG_PATH)",
      adapterID: "lua-local",
      launch: {
        ...common,
        type: "lua-local",
        program: { lua: selected.lua, file: program },
        extensionPath: pathOps.dirname(pathOps.dirname(pathOps.resolve(cwd, selected.luaDebug))),
        workspacePath: cwd,
      },
    };
  if (options.adapter === "shell")
    return {
      command: "node",
      overrides: [],
      args: [selected.bashDebug ?? path.posix.join(selected.bashRoot, "out/bashDebug.js")],
      adapterID: "bashdb",
      launch: {
        ...common,
        type: "bashdb",
        pathBash: selected.bash,
        pathBashdb: path.posix.join(selected.bashRoot, "bashdb_dir/bashdb"),
        pathBashdbLib: path.posix.join(selected.bashRoot, "bashdb_dir"),
        pathCat: "/usr/bin/cat",
        pathMkfifo: "/usr/bin/mkfifo",
        pathPkill: "/usr/bin/pkill",
        terminalKind: "debugConsole",
        argsString: "",
        env: {},
        showDebugOutput: false,
        trace: false,
      },
    };
  throw new SshBackendError("CAPABILITY_UNAVAILABLE", options.program, "not-applied");
}

function stdioRecipe(
  options: DebugSessionOptions,
  program: string,
  cwd: string,
  source: string,
  os: SshTargetOs,
): StdioRecipe {
  const common = {
    name: "Pi Agent IDE debug session",
    request: "launch",
    program,
    cwd,
    args: [...options.args],
  };
  switch (options.adapter) {
    case "debugpy": {
      return {
        command: "python3",
        overrides: ["PI_PYTHON_PATH"],
        args: ["-m", "debugpy.adapter"],
        dependency: "Python with debugpy installed (project virtual environment or PI_PYTHON_PATH)",
        adapterID: "debugpy",
        launch: { ...common, type: "python", console: "internalConsole", justMyCode: false },
      };
    }
    case "dart": {
      return {
        command: "dart",
        overrides: ["PI_DART_PATH"],
        args: ["debug_adapter"],
        adapterID: "dart",
        launch: {
          ...common,
          type: "dart",
          debugSdkLibraries: false,
          debugExternalPackageLibraries: false,
          stopOnEntry: true,
          vmAdditionalArgs: ["--pause-isolates-on-start"],
        },
      };
    }
    case "kotlin": {
      if (options.mainClass === undefined)
        throw new Error("Java and Kotlin debug sessions require mainClass");
      return {
        command: "kotlin-debug-adapter",
        overrides: ["PI_KOTLIN_DEBUG_ADAPTER_PATH"],
        args: [],
        adapterID: options.adapter,
        launch: {
          ...common,
          type: "kotlin",
          mainClass: options.mainClass,
          projectRoot: cwd,
          stopOnEntry: true,
        },
      };
    }
    case "netcoredbg": {
      return {
        command: "netcoredbg",
        overrides: ["PI_NETCOREDBG_PATH"],
        args: ["--interpreter=vscode"],
        adapterID: "coreclr",
        launch: { ...common, type: "coreclr", console: "internalConsole" },
      };
    }
    case "elixir": {
      return {
        command:
          os === "windows"
            ? WINDOWS_SSH_ELIXIR_DEBUG_COMMAND
            : "/opt/pi-debug-adapters/elixir-ls/debug_adapter.sh",
        overrides: ["PI_ELIXIR_LS_DEBUG_PATH"],
        args: [],
        adapterID: "mix_task",
        launch: {
          name: common.name,
          request: "launch",
          type: "mix_task",
          task: "run",
          taskArgs: [program, ...options.args],
          projectDir: cwd,
          startApps: true,
          exitAfterTaskReturns: true,
        },
      };
    }
    case "lldb-dap": {
      const swift = path.posix.extname(source).toLowerCase() === ".swift";
      return {
        command: swift || os === "windows" ? "lldb-dap" : "lldb-dap-18",
        overrides: swift ? ["PI_SWIFT_LLDB_DAP_PATH", "PI_LLDB_DAP_PATH"] : ["PI_LLDB_DAP_PATH"],
        args: [],
        adapterID: "lldb-dap",
        launch: { ...common, type: "lldb-dap" },
      };
    }
    default: {
      throw new SshBackendError("CAPABILITY_UNAVAILABLE", options.program, "not-applied");
    }
  }
}

/** Bind debugger source paths and adapter stdio to the explicitly selected target. */
export function createSshDebuggerWorkspaceOwner(
  registry: SshBackendRegistry,
): DebugWorkspaceOwnerResolver {
  return (cwd) => {
    const root = registry.resolve(cwd);
    if (!root) {
      if (cwd.includes("://")) throw new SshBackendError("UNSUPPORTED_SOURCE", cwd, "not-applied");
      return undefined;
    }
    const resolve = (source: string) => {
      const owner = registry.resolve(source, root.location.source);
      if (!owner || owner.location.target !== root.location.target)
        throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
      return owner;
    };
    const { id, host, workspace, configFile } = root.backend.target;
    const os = targetOs(root.backend.target);
    const pathOps = os === "windows" ? path.win32 : path.posix;
    const serverPath = (source: string) => sshNativePath(resolve(source).location.path, os);
    return {
      key: JSON.stringify([id, host, workspace, configFile ?? null, os]),
      serverPath,
      resourcePath(nativePath) {
        if (os === "windows" && !/^[A-Za-z]:[\\/]/u.test(nativePath))
          throw new SshBackendError("INVALID_RESPONSE", root.location.source, "not-applied");
        try {
          return remoteLocation(root.location.target, nativePath, os).source;
        } catch {
          throw new SshBackendError("INVALID_RESPONSE", root.location.source, "not-applied");
        }
      },
      async readText(source) {
        const owner = resolve(source);
        return new TextDecoder("utf-8", { fatal: true }).decode(
          (await owner.backend.read(owner.location.path)).bytes,
        );
      },
      async prepare(options, signal) {
        signal?.throwIfAborted();
        const program = serverPath(options.program);
        const nativeCwd = serverPath(options.cwd);
        const source = serverPath(options.sourceFile);
        if (os === "windows" && linuxBrokers.has(options.adapter)) {
          const error = new SshBackendError(
            "CAPABILITY_UNAVAILABLE",
            root.location.source,
            "not-applied",
          );
          error.message += ` (${options.adapter} requires the Linux SSH debugger broker)`;
          throw error;
        }
        if (options.adapter === "java")
          return await prepareSshJavaDebugger(
            registry,
            root.location.source,
            { ...options, cwd: nativeCwd, program, sourceFile: source },
            signal,
          );
        if (
          options.adapter === "delve" ||
          options.adapter === "ruby" ||
          options.adapter === "julia"
        ) {
          const transport = await startSshTcpDapTransport(registry, root.location.source, {
            kind: options.adapter,
            program,
            args: options.args,
            signal,
          });
          const adapterID =
            options.adapter === "delve" ? "go" : options.adapter === "ruby" ? "rdbg" : "julia";
          return {
            client: DapClient.fromTransport(transport),
            adapterID,
            request: "launch",
            remote: transport.remote,
            launch: {
              name: "Pi Agent IDE debug session",
              request: "launch",
              type: adapterID,
              program,
              cwd: nativeCwd,
              args: [...options.args],
              ...(options.adapter === "delve" ? { mode: "debug" } : {}),
              ...(options.adapter === "julia" ? { stopOnEntry: false } : {}),
            },
          };
        }
        if (options.adapter === "node") {
          return prepareSshNodeDebugger(
            registry,
            root.location.source,
            {
              name: "Pi Agent IDE debug session",
              request: "launch",
              type: "pwa-node",
              program,
              cwd: nativeCwd,
              args: [...options.args],
              console: "internalConsole",
              autoAttachChildProcesses: false,
              stopOnEntry: true,
              sourceMaps: true,
              pauseForSourceMap: true,
              outFiles: [
                pathOps.join(pathOps.dirname(program), "**", "*.js").replaceAll(pathOps.sep, "/"),
              ],
            },
            signal,
          );
        }
        if (options.adapter === "r") {
          const worker = await rWorker;
          const transport = await startSshDapTransport(registry, root.location.source, {
            command: remotePython(worker),
            args: [],
            signal,
          });
          return {
            client: DapClient.fromTransport(transport),
            adapterID: "R-Debugger",
            request: "launch",
            remote: transport.remote,
            launch: {
              name: "Pi Agent IDE debug session",
              request: "launch",
              type: "R-Debugger",
              debugMode: "file",
              file: program,
              workingDirectory: nativeCwd,
              commandLineArgs: [...options.args],
              allowGlobalDebugging: false,
              loadPackages: [],
              supportsStdoutReading: true,
              supportsWriteToStdinEvent: true,
              overwriteHelp: false,
            },
          };
        }
        if (options.adapter === "powershell") {
          const worker = await powershellWorker;
          const transport = await startSshDapTransport(registry, root.location.source, {
            command: remotePython(worker),
            args: [],
            signal,
          });
          return {
            client: DapClient.fromTransport(transport),
            adapterID: "PowerShell",
            request: "launch",
            remote: transport.remote,
            launch: {
              name: "Pi Agent IDE debug session",
              request: "launch",
              program,
              script: program,
              cwd: nativeCwd,
              args: [...options.args],
              createTemporaryIntegratedConsole: false,
              executeMode: "Call",
            },
          };
        }
        const recipe =
          options.adapter === "php" || options.adapter === "lua" || options.adapter === "shell"
            ? await nodeStdioRecipe(
                root.backend,
                options,
                program,
                nativeCwd,
                root.location.path,
                os,
                signal,
              )
            : stdioRecipe(options, program, nativeCwd, source, os);
        const { command } = await resolveSshDebuggerExecutable(
          root.backend,
          root.location.path,
          options.program,
          {
            command: recipe.command,
            overrides: recipe.overrides,
            python: options.adapter === "debugpy",
            files: recipe.files,
            dependency: recipe.dependency ?? [recipe.command, ...recipe.overrides].join(" / "),
          },
          signal,
        );
        const transport = await startSshDapTransport(registry, root.location.source, {
          command,
          args: recipe.args,
          signal,
        });
        return {
          client: DapClient.fromTransport(transport),
          adapterID: recipe.adapterID,
          request: "launch",
          remote: transport.remote,
          launch: recipe.launch,
        };
      },
    };
  };
}
