import path from "node:path";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { DapClient } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";
import type { DebugWorkspaceOwnerResolver } from "#src/plugins/pi-agent-ide-debugger/src/workspace-owner.js";
import type { SshBackendRegistry } from "./registry.js";
import { remoteLocation } from "./identity.js";
import { SshBackendError, type SshBackend } from "./ssh.js";
import { startSshDapTransport } from "./dap-transport.js";
import { startSshTcpDapTransport } from "./dap-tcp-transport.js";
import { prepareSshNodeDebugger } from "./dap-node-transport.js";
import { prepareSshJavaDebugger } from "./dap-java-transport.js";
import type { DebugSessionOptions } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

type StdioRecipe = {
  readonly command: string;
  readonly overrides: readonly string[];
  readonly args: readonly string[];
  readonly adapterID: string;
  readonly launch: Record<string, unknown>;
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
  signal?: AbortSignal,
): Promise<StdioRecipe> {
  const selections = {
    phpDebug: ["PI_PHP_DEBUG_PATH", "/opt/pi-debug-adapters/php-debug/extension/out/phpDebug.js"],
    php: ["PI_PHP_PATH", "php"],
    luaDebug: [
      "PI_LUA_DEBUG_PATH",
      "/opt/pi-debug-adapters/lua-debug/extension/extension/debugAdapter.js",
    ],
    lua: ["PI_LUA_PATH", "lua"],
    bashRoot: ["PI_BASH_DEBUG_ROOT", "/opt/pi-debug-adapters/bash-debug/extension"],
    bashDebug: ["PI_BASH_DEBUG_PATH", null],
    bash: ["PI_BASH_PATH", "/usr/bin/bash"],
  };
  // Read only known adapter executable paths, never the controller's environment.
  const result = await backend.execute(
    "python3",
    [
      "-c",
      "import json,os,sys; fields=json.loads(sys.argv[1]); print(json.dumps({k:os.environ.get(v[0],v[1]) for k,v in fields.items()}))",
      JSON.stringify(selections),
    ],
    cwd,
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
      adapterID: "lua-local",
      launch: {
        ...common,
        type: "lua-local",
        program: { lua: selected.lua, file: program },
        extensionPath: path.posix.dirname(path.posix.dirname(selected.luaDebug)),
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
        command: "/opt/pi-debug-adapters/elixir-ls/debug_adapter.sh",
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
        command: swift ? "lldb-dap" : "lldb-dap-18",
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
    return {
      key: JSON.stringify([id, host, workspace, configFile ?? null]),
      serverPath: (source) => resolve(source).location.path,
      resourcePath(nativePath) {
        if (!path.posix.isAbsolute(nativePath) || nativePath.includes("\0"))
          throw new SshBackendError("INVALID_RESPONSE", root.location.source, "not-applied");
        return remoteLocation(root.location.target, nativePath).source;
      },
      async readText(source) {
        const owner = resolve(source);
        return new TextDecoder("utf-8", { fatal: true }).decode(
          (await owner.backend.read(owner.location.path)).bytes,
        );
      },
      async prepare(options, signal) {
        signal?.throwIfAborted();
        const program = resolve(options.program).location.path;
        const nativeCwd = resolve(options.cwd).location.path;
        const source = resolve(options.sourceFile).location.path;
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
              outFiles: [path.posix.join(path.posix.dirname(program), "**", "*.js")],
            },
            signal,
          );
        }
        if (options.adapter === "r") {
          const worker = await readFile(new URL("./dap-r-worker.py", import.meta.url), "utf8");
          const transport = await startSshDapTransport(registry, root.location.source, {
            command: "python3",
            args: ["-c", worker],
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
          const worker = await readFile(
            new URL("./dap-powershell-worker.py", import.meta.url),
            "utf8",
          );
          const transport = await startSshDapTransport(registry, root.location.source, {
            command: "python3",
            args: ["-c", worker],
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
            ? await nodeStdioRecipe(root.backend, options, program, nativeCwd, signal)
            : stdioRecipe(options, program, nativeCwd, source);
        const transport = await startSshDapTransport(registry, root.location.source, {
          command: "python3",
          args: [
            "-c",
            "import json,os,sys; names=json.loads(sys.argv[1]); p=next((os.environ[n] for n in names if os.environ.get(n)),sys.argv[2]); args=json.loads(sys.argv[3]); os.execvpe(p,[p,*args],os.environ)",
            JSON.stringify(recipe.overrides),
            recipe.command,
            JSON.stringify(recipe.args),
          ],
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
