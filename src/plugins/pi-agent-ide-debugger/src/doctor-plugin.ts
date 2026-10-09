import {
  projectExecutableAvailable,
  probeProjectExecutable,
  projectFileExists,
} from "pi-agent-doctor/api/project-probes";
import {
  DOCTOR_API_VERSION,
  DOCTOR_PROTOCOL,
  type DoctorContext,
  type DoctorFinding,
  type DoctorPlugin,
  type DoctorSetupAction,
  type DoctorSetupInspection,
} from "pi-agent-doctor/api/plugin-protocol";

import { resolvePythonDebuggerCommand } from "./adapter-executables.js";
import { JavaDebugRuntime, javaDebuggerFiles, javaExecutable } from "./java-runtime.js";
import {
  DEBUGGER_LANGUAGE_MATRIX,
  DEBUGGER_RECIPES,
  debuggerRecipeForLanguage,
} from "./catalog.js";

const DEFAULT_JS_DEBUG_PATH = "/opt/pi-debug-adapters/js-debug/src/dapDebugServer.js";
const DEFAULT_ELIXIR_LS_DEBUG_PATH = "/opt/pi-debug-adapters/elixir-ls/debug_adapter.sh";

/** Doctor contribution for debugger dependencies supported by the debug tool. */
export const debuggerDoctorPlugin: DoctorPlugin = {
  protocol: DOCTOR_PROTOCOL,
  apiVersion: DOCTOR_API_VERSION,
  id: "debugger",
  setup(api): void {
    for (const recipe of DEBUGGER_RECIPES) api.addToolRecipe(recipe);
    api.addSetupCheck({ id: "effective-config", inspect: inspectDebuggerSetup });
    api.addCheck({
      id: "adapters",
      title: "Debug adapters",
      run: checkDebuggerAdapters,
    });
  },
};

/** Inspect debugger selection and classify missing Linux prerequisites. */
export async function inspectDebuggerSetup(
  context: DoctorContext,
  platform: NodeJS.Platform = context.workspace?.platform ?? process.platform,
): Promise<DoctorSetupInspection> {
  const recipes = new Map(
    [...context.detectedLanguageIds]
      .map(debuggerRecipeForLanguage)
      .filter((recipe) => recipe !== undefined)
      .map((recipe) => [recipe.id, recipe]),
  );
  const selections = [...context.detectedLanguageIds].flatMap((languageId) => {
    const recipe = debuggerRecipeForLanguage(languageId);
    return recipe === undefined
      ? []
      : [{ kind: "debugger" as const, languageId, toolId: recipe.id }];
  });
  const actions: DoctorSetupAction[] = [];
  for (const entry of DEBUGGER_LANGUAGE_MATRIX) {
    if (entry.status === "planned" && context.detectedLanguageIds.has(entry.language)) {
      actions.push({
        id: `debugger-${entry.language}-not-verified`,
        message: `${entry.backend} is selected for ${entry.language}, but its Linux debugger integration is not verified yet`,
      });
    }
  }
  for (const recipe of recipes.values()) {
    const debuggerRecipe = recipe.debugger;
    if (debuggerRecipe === undefined) continue;
    const supportedPlatform =
      platform === "linux" || platform === "darwin" || platform === "win32" ? platform : undefined;
    if (supportedPlatform === undefined || !debuggerRecipe.platforms.includes(supportedPlatform)) {
      actions.push({
        id: `debugger-${recipe.id}-platform`,
        category: "unsupported-platform",
        message: `${recipe.name} does not support the ${platform} debugger recipe`,
      });
      continue;
    }
    const python = recipe.id === "debugpy" ? await pythonCommand(context, platform) : undefined;
    const missingRuntime = await firstMissingExecutable(
      recipe.id === "java-debug"
        ? [javaExecutable(context.env)]
        : python === undefined
          ? debuggerRecipe.runtimeExecutables
          : [python.command],
      context,
    );
    if (missingRuntime !== undefined) {
      actions.push({
        id: `debugger-${recipe.id}-runtime`,
        category: "missing-runtime",
        message: `Runtime ${missingRuntime} is unavailable. ${debuggerRecipe.install}`,
      });
      continue;
    }
    if (!(await adapterInstalled(recipe.id, context, platform))) {
      actions.push({
        id: `debugger-${recipe.id}-adapter`,
        category: "missing-adapter",
        message: `${recipe.name} is not installed. ${debuggerRecipe.install}`,
      });
      continue;
    }
    if (!(await adapterAvailable(recipe.id, context, platform))) {
      actions.push({
        id: `debugger-${recipe.id}-startup`,
        category: "adapter-startup",
        message: `${recipe.name} is installed but cannot start. ${debuggerRecipe.install}`,
      });
    }
  }
  return { selections, actions };
}

async function checkDebuggerAdapters(context: DoctorContext): Promise<readonly DoctorFinding[]> {
  const recipes = [
    ...new Map(
      [...context.detectedLanguageIds]
        .map(debuggerRecipeForLanguage)
        .filter((recipe) => recipe !== undefined)
        .map((recipe) => [recipe.id, recipe]),
    ).values(),
  ];
  if (recipes.length === 0) {
    return [{ status: "skip", message: "No supported executable language was detected" }];
  }
  return Promise.all(
    recipes.map(async (recipe): Promise<DoctorFinding> => {
      let result = await probeAdapter(recipe.id, context);
      if (recipe.id === "java-debug" && result.ok && context.workspace === undefined) {
        const runtime = new JavaDebugRuntime();
        try {
          await runtime.connect(context.cwd, AbortSignal.timeout(20_000), context.env);
          result = { ok: true, detail: `${result.detail}\nJava DAP bridge ready` };
        } catch (error) {
          result = { ok: false, detail: error instanceof Error ? error.message : String(error) };
        } finally {
          await runtime.close();
        }
      }
      return {
        status: result.ok ? "pass" : "fail",
        message: `${recipe.name}: ${result.ok ? "available" : "unavailable"}`,
        detail: result.detail,
      };
    }),
  );
}

async function probeJavaFiles(
  context: DoctorContext,
  platform: NodeJS.Platform,
): Promise<{ ok: boolean; detail: string }> {
  if (context.workspace !== undefined) {
    return probeProjectExecutable(context, "python3", [
      "-c",
      "import glob,os,sys; home,plugin=sys.argv[1:]; launchers=glob.glob(os.path.join(home,'plugins','org.eclipse.equinox.launcher_*.jar')); ok=len(launchers)==1 and os.path.isfile(plugin) and os.path.isdir(os.path.join(home,'config_linux')); print('Java debugger files ready' if ok else 'Missing JDT LS or java-debug plugin'); sys.exit(0 if ok else 1)",
      context.env.PI_JDTLS_HOME ?? "/opt/pi-debug-adapters/jdtls",
      context.env.PI_JAVA_DEBUG_PLUGIN_PATH ??
        "/opt/pi-debug-adapters/java-debug/com.microsoft.java.debug.plugin-0.53.2.jar",
    ]);
  }
  try {
    await javaDebuggerFiles(context.env, platform);
    return { ok: true, detail: "Java debugger files ready" };
  } catch (error) {
    context.signal?.throwIfAborted();
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
async function firstMissingExecutable(
  executables: readonly string[],
  context: DoctorContext,
): Promise<string | undefined> {
  for (const executable of executables) {
    if (!(await projectExecutableAvailable(context, executable))) return executable;
  }
  return undefined;
}
async function adapterInstalled(
  id: string,
  context: DoctorContext,
  platform: NodeJS.Platform = context.workspace?.platform ?? process.platform,
): Promise<boolean> {
  const { env } = context;
  if (id === "elixir-ls-debug-adapter") {
    return adapterFileExists(context, env.PI_ELIXIR_LS_DEBUG_PATH ?? DEFAULT_ELIXIR_LS_DEBUG_PATH);
  }
  if (id === "vsc-debugger") {
    return (
      await probeProjectExecutable(context, env.PI_R_PATH ?? "R", [
        "--vanilla",
        "--quiet",
        "-e",
        "quit(status=if (requireNamespace('vscDebugger', quietly=TRUE)) 0 else 1)",
      ])
    ).ok;
  }
  if (id === "vscode-js-debug") {
    return adapterFileExists(context, env.PI_JS_DEBUG_PATH ?? DEFAULT_JS_DEBUG_PATH);
  }
  if (id.startsWith("lldb-dap")) {
    return (
      (await projectExecutableAvailable(
        context,
        env.PI_LLDB_DAP_PATH ?? (platform === "win32" ? "lldb-dap" : "lldb-dap-18"),
      )) || (await projectExecutableAvailable(context, "lldb-dap"))
    );
  }
  if (id === "delve") return projectExecutableAvailable(context, env.PI_DELVE_PATH ?? "dlv");
  if (id === "java-debug") {
    try {
      if (context.workspace !== undefined) {
        return (await probeJavaFiles(context, platform)).ok;
      }
      await javaDebuggerFiles(env, platform);
      return true;
    } catch {
      return false;
    }
  }
  if (id === "kotlin-debug-adapter")
    return projectExecutableAvailable(
      context,
      env.PI_KOTLIN_DEBUG_ADAPTER_PATH ?? "kotlin-debug-adapter",
    );
  if (id === "julia-debug-adapter") {
    return adapterFileExists(
      context,
      `${env.PI_JULIA_DEBUG_PROJECT ?? "/opt/pi-debug-adapters/julia"}/Project.toml`,
    );
  }
  if (id === "dart-debug-adapter")
    return projectExecutableAvailable(context, env.PI_DART_PATH ?? "dart");
  if (id === "netcoredbg")
    return projectExecutableAvailable(context, env.PI_NETCOREDBG_PATH ?? "netcoredbg");
  if (id === "rdbg") return projectExecutableAvailable(context, env.PI_RUBY_DEBUG_PATH ?? "rdbg");
  const adapterFiles: Record<string, string> = {
    "vscode-php-debug":
      env.PI_PHP_DEBUG_PATH ?? "/opt/pi-debug-adapters/php-debug/extension/out/phpDebug.js",
    "local-lua-debugger":
      env.PI_LUA_DEBUG_PATH ??
      "/opt/pi-debug-adapters/lua-debug/extension/extension/debugAdapter.js",
    "vscode-bash-debug":
      env.PI_BASH_DEBUG_PATH ?? "/opt/pi-debug-adapters/bash-debug/extension/out/bashDebug.js",
    "powershell-editor-services-debug": `${env.PI_POWERSHELL_EDITOR_SERVICES_PATH ?? "/opt/pi-debug-adapters/powershell-editor-services"}/PowerShellEditorServices/Start-EditorServices.ps1`,
  };
  const adapterFile = adapterFiles[id];
  if (adapterFile !== undefined) {
    return adapterFileExists(context, adapterFile);
  }
  if (id !== "debugpy") return false;
  const python = await pythonCommand(context, platform);
  const probe = await probeProjectExecutable(context, python.command, [
    ...python.args,
    "-c",
    "import importlib.util; raise SystemExit(importlib.util.find_spec('debugpy') is None)",
  ]);
  return probe.ok;
}
async function adapterAvailable(
  id: string,
  context: DoctorContext,
  platform: NodeJS.Platform = context.workspace?.platform ?? process.platform,
): Promise<boolean> {
  return (await probeAdapter(id, context, platform)).ok;
}

async function probeAdapter(
  id: string,
  context: DoctorContext,
  platform: NodeJS.Platform = context.workspace?.platform ?? process.platform,
) {
  const { env } = context;
  if (id === "elixir-ls-debug-adapter") {
    return probeAdapterFile(env.PI_ELIXIR_LS_DEBUG_PATH ?? DEFAULT_ELIXIR_LS_DEBUG_PATH, context);
  }
  if (id === "vsc-debugger") {
    return probeProjectExecutable(context, env.PI_R_PATH ?? "R", [
      "--vanilla",
      "--quiet",
      "-e",
      "library(vscDebugger); cat(as.character(packageVersion('vscDebugger')))",
    ]);
  }
  if (id === "dart-debug-adapter") {
    return probeProjectExecutable(context, env.PI_DART_PATH ?? "dart", ["--version"]);
  }
  if (id === "debugpy") {
    const python = await pythonCommand(context, platform);
    return probeProjectExecutable(context, python.command, [
      ...python.args,
      "-c",
      "import debugpy; print(debugpy.__version__)",
    ]);
  }
  if (id === "delve") {
    return probeProjectExecutable(context, env.PI_DELVE_PATH ?? "dlv", ["version"]);
  }
  if (id === "julia-debug-adapter") {
    const project = env.PI_JULIA_DEBUG_PROJECT ?? "/opt/pi-debug-adapters/julia";
    return probeProjectExecutable(context, env.PI_JULIA_PATH ?? "julia", [
      `--project=${project}`,
      "--startup-file=no",
      "-e",
      "using DebugAdapter",
    ]);
  }
  if (id === "java-debug") {
    const files = await probeJavaFiles(context, platform);
    if (!files.ok) return files;
    const runtime = await probeProjectExecutable(context, javaExecutable(env), ["-version"]);
    if (!runtime.ok) return runtime;
    const major = /version "(\d+)/u.exec(runtime.detail)?.[1];
    return Number(major) >= 21
      ? runtime
      : {
          ok: false,
          detail: "Java debugger requires JDK 21 or newer. Set PI_JAVA_PATH or JAVA_HOME.",
        };
  }
  if (id === "kotlin-debug-adapter") {
    const adapter = await probeProjectExecutable(
      context,
      env.PI_KOTLIN_DEBUG_ADAPTER_PATH ?? "kotlin-debug-adapter",
      ["--help"],
    );
    if (!adapter.ok) return adapter;
    return probeProjectExecutable(context, "java", ["-version"]);
  }
  if (id === "netcoredbg") {
    const adapter = await probeProjectExecutable(context, env.PI_NETCOREDBG_PATH ?? "netcoredbg", [
      "--version",
    ]);
    if (!adapter.ok) return adapter;
    return probeProjectExecutable(context, "dotnet", ["--version"]);
  }
  if (id.startsWith("lldb-dap")) {
    const command =
      env.PI_LLDB_DAP_PATH ??
      (platform === "win32"
        ? "lldb-dap"
        : (await projectExecutableAvailable(context, "lldb-dap-18"))
          ? "lldb-dap-18"
          : "lldb-dap");
    return probeProjectExecutable(context, command, ["--version"]);
  }
  if (id === "rdbg") {
    return probeProjectExecutable(context, env.PI_RUBY_DEBUG_PATH ?? "rdbg", ["--version"]);
  }
  if (id === "vscode-php-debug") {
    const runtime = await probeProjectExecutable(context, env.PI_PHP_PATH ?? "php", [
      "-r",
      "exit(extension_loaded('xdebug') ? 0 : 1);",
    ]);
    return runtime.ok
      ? probeAdapterFile(
          env.PI_PHP_DEBUG_PATH ?? "/opt/pi-debug-adapters/php-debug/extension/out/phpDebug.js",
          context,
        )
      : runtime;
  }
  if (id === "local-lua-debugger") {
    const runtime = await probeProjectExecutable(context, env.PI_LUA_PATH ?? "lua", ["-v"]);
    return runtime.ok
      ? probeAdapterFile(
          env.PI_LUA_DEBUG_PATH ??
            "/opt/pi-debug-adapters/lua-debug/extension/extension/debugAdapter.js",
          context,
        )
      : runtime;
  }
  if (id === "vscode-bash-debug") {
    const runtime = await probeProjectExecutable(context, env.PI_BASH_PATH ?? "bash", [
      "--version",
    ]);
    return runtime.ok
      ? probeAdapterFile(
          env.PI_BASH_DEBUG_PATH ?? "/opt/pi-debug-adapters/bash-debug/extension/out/bashDebug.js",
          context,
        )
      : runtime;
  }
  if (id === "powershell-editor-services-debug") {
    const runtime = await probeProjectExecutable(context, env.PI_PWSH_PATH ?? "pwsh", [
      "--version",
    ]);
    const bundle =
      env.PI_POWERSHELL_EDITOR_SERVICES_PATH ?? "/opt/pi-debug-adapters/powershell-editor-services";
    return runtime.ok
      ? probeAdapterFile(`${bundle}/PowerShellEditorServices/Start-EditorServices.ps1`, context)
      : runtime;
  }
  if (id !== "vscode-js-debug") {
    return { ok: false as const, detail: `Unknown debugger adapter: ${id}` };
  }
  const server = env.PI_JS_DEBUG_PATH ?? DEFAULT_JS_DEBUG_PATH;
  if (!(await adapterFileExists(context, server)))
    return { ok: false as const, detail: `${server} does not exist` };
  return probeProjectExecutable(context, context.workspace ? "node" : process.execPath, [
    "-e",
    "const fs=require('node:fs'); fs.accessSync(process.argv[1]); console.log(process.version)",
    server,
  ]);
}

async function probeAdapterFile(file: string, context: DoctorContext) {
  if (!(await adapterFileExists(context, file)))
    return { ok: false as const, detail: `${file} does not exist` };
  return probeProjectExecutable(context, context.workspace ? "node" : process.execPath, [
    "-e",
    "const fs=require('node:fs'); fs.accessSync(process.argv[1])",
    file,
  ]);
}

async function pythonCommand(context: DoctorContext, platform: NodeJS.Platform) {
  return resolvePythonDebuggerCommand(context.cwd, context.env, platform, (command) =>
    projectExecutableAvailable(context, command),
  );
}

async function adapterFileExists(context: DoctorContext, file: string): Promise<boolean> {
  if (!context.workspace) return projectFileExists(context, file);
  const base = context.workspace.toNativeUri(context.cwd).replace(/\/?$/u, "/");
  const nativePath = file.split("/").map(encodeURIComponent).join("/");
  const source = context.workspace.fromNativeUri(new URL(nativePath, base).href);
  return projectFileExists(context, source);
}
