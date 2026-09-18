import { access } from "node:fs/promises";

import { isExecutableAvailable, probeExecutable } from "pi-agent-doctor/api/executable";
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
  platform: NodeJS.Platform = process.platform,
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
    const python =
      recipe.id === "debugpy"
        ? await resolvePythonDebuggerCommand(context.cwd, context.env, platform)
        : undefined;
    const missingRuntime = await firstMissingExecutable(
      python === undefined ? debuggerRecipe.runtimeExecutables : [python.command],
      context.cwd,
      context.env,
    );
    if (missingRuntime !== undefined) {
      actions.push({
        id: `debugger-${recipe.id}-runtime`,
        category: "missing-runtime",
        message: `Runtime ${missingRuntime} is unavailable. ${debuggerRecipe.install}`,
      });
      continue;
    }
    if (!(await adapterInstalled(recipe.id, context.cwd, context.env, platform))) {
      actions.push({
        id: `debugger-${recipe.id}-adapter`,
        category: "missing-adapter",
        message: `${recipe.name} is not installed. ${debuggerRecipe.install}`,
      });
      continue;
    }
    if (!(await adapterAvailable(recipe.id, context.cwd, context.env, platform))) {
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
      const result = await probeAdapter(recipe.id, context.cwd, context.env);
      return {
        status: result.ok ? "pass" : "fail",
        message: `${recipe.name}: ${result.ok ? "available" : "unavailable"}`,
        detail: result.detail,
      };
    }),
  );
}

async function firstMissingExecutable(
  executables: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (const executable of executables) {
    if (!(await isExecutableAvailable(executable, cwd, env))) return executable;
  }
  return undefined;
}
async function adapterInstalled(
  id: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (id === "elixir-ls-debug-adapter") {
    try {
      await access(env.PI_ELIXIR_LS_DEBUG_PATH ?? DEFAULT_ELIXIR_LS_DEBUG_PATH);
      return true;
    } catch {
      return false;
    }
  }
  if (id === "vsc-debugger") {
    return (
      await probeExecutable(
        env.PI_R_PATH ?? "R",
        [
          "--vanilla",
          "--quiet",
          "-e",
          "quit(status=if (requireNamespace('vscDebugger', quietly=TRUE)) 0 else 1)",
        ],
        cwd,
        env,
      )
    ).ok;
  }
  if (id === "vscode-js-debug") {
    try {
      await access(env.PI_JS_DEBUG_PATH ?? DEFAULT_JS_DEBUG_PATH);
      return true;
    } catch {
      return false;
    }
  }
  if (id.startsWith("lldb-dap")) {
    return (
      (await isExecutableAvailable(
        env.PI_LLDB_DAP_PATH ?? (platform === "win32" ? "lldb-dap" : "lldb-dap-18"),
        cwd,
        env,
      )) || (await isExecutableAvailable("lldb-dap", cwd, env))
    );
  }
  if (id === "delve") return isExecutableAvailable(env.PI_DELVE_PATH ?? "dlv", cwd, env);
  if (id === "kotlin-debug-adapter")
    return isExecutableAvailable(
      env.PI_KOTLIN_DEBUG_ADAPTER_PATH ?? "kotlin-debug-adapter",
      cwd,
      env,
    );
  if (id === "julia-debug-adapter") {
    try {
      await access(`${env.PI_JULIA_DEBUG_PROJECT ?? "/opt/pi-debug-adapters/julia"}/Project.toml`);
      return true;
    } catch {
      return false;
    }
  }
  if (id === "dart-debug-adapter")
    return isExecutableAvailable(env.PI_DART_PATH ?? "dart", cwd, env);
  const python = await resolvePythonDebuggerCommand(cwd, env, platform);
  const probe = await probeExecutable(
    python.command,
    [
      ...python.args,
      "-c",
      "import importlib.util; raise SystemExit(importlib.util.find_spec('debugpy') is None)",
    ],
    cwd,
    env,
  );
  return probe.ok;
}
async function adapterAvailable(
  id: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  return (await probeAdapter(id, cwd, env, platform)).ok;
}

async function probeAdapter(
  id: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  if (id === "elixir-ls-debug-adapter") {
    return probeAdapterFile(env.PI_ELIXIR_LS_DEBUG_PATH ?? DEFAULT_ELIXIR_LS_DEBUG_PATH, cwd, env);
  }
  if (id === "vsc-debugger") {
    return probeExecutable(
      env.PI_R_PATH ?? "R",
      [
        "--vanilla",
        "--quiet",
        "-e",
        "library(vscDebugger); cat(as.character(packageVersion('vscDebugger')))",
      ],
      cwd,
      env,
    );
  }
  if (id === "dart-debug-adapter") {
    return probeExecutable(env.PI_DART_PATH ?? "dart", ["--version"], cwd, env);
  }
  if (id === "debugpy") {
    const python = await resolvePythonDebuggerCommand(cwd, env, platform);
    return probeExecutable(
      python.command,
      [...python.args, "-c", "import debugpy; print(debugpy.__version__)"],
      cwd,
      env,
    );
  }
  if (id === "delve") {
    return probeExecutable(env.PI_DELVE_PATH ?? "dlv", ["version"], cwd, env);
  }
  if (id === "julia-debug-adapter") {
    const project = env.PI_JULIA_DEBUG_PROJECT ?? "/opt/pi-debug-adapters/julia";
    return probeExecutable(
      env.PI_JULIA_PATH ?? "julia",
      [`--project=${project}`, "--startup-file=no", "-e", "using DebugAdapter"],
      cwd,
      env,
    );
  }
  if (id === "kotlin-debug-adapter") {
    const adapter = await probeExecutable(
      env.PI_KOTLIN_DEBUG_ADAPTER_PATH ?? "kotlin-debug-adapter",
      ["--help"],
      cwd,
      env,
    );
    if (!adapter.ok) return adapter;
    return probeExecutable("java", ["-version"], cwd, env);
  }
  if (id === "netcoredbg") {
    const adapter = await probeExecutable(
      env.PI_NETCOREDBG_PATH ?? "netcoredbg",
      ["--version"],
      cwd,
      env,
    );
    if (!adapter.ok) return adapter;
    return probeExecutable("dotnet", ["--version"], cwd, env);
  }
  if (id.startsWith("lldb-dap")) {
    const command =
      env.PI_LLDB_DAP_PATH ??
      (platform === "win32"
        ? "lldb-dap"
        : (await isExecutableAvailable("lldb-dap-18", cwd, env))
          ? "lldb-dap-18"
          : "lldb-dap");
    return probeExecutable(command, ["--version"], cwd, env);
  }
  if (id === "rdbg") {
    return probeExecutable(env.PI_RUBY_DEBUG_PATH ?? "rdbg", ["--version"], cwd, env);
  }
  if (id === "vscode-php-debug") {
    const runtime = await probeExecutable(
      env.PI_PHP_PATH ?? "php",
      ["-r", "exit(extension_loaded('xdebug') ? 0 : 1);"],
      cwd,
      env,
    );
    return runtime.ok
      ? probeAdapterFile(
          env.PI_PHP_DEBUG_PATH ?? "/opt/pi-debug-adapters/php-debug/extension/out/phpDebug.js",
          cwd,
          env,
        )
      : runtime;
  }
  if (id === "local-lua-debugger") {
    const runtime = await probeExecutable(env.PI_LUA_PATH ?? "lua", ["-v"], cwd, env);
    return runtime.ok
      ? probeAdapterFile(
          env.PI_LUA_DEBUG_PATH ??
            "/opt/pi-debug-adapters/lua-debug/extension/extension/debugAdapter.js",
          cwd,
          env,
        )
      : runtime;
  }
  if (id === "vscode-bash-debug") {
    const runtime = await probeExecutable(env.PI_BASH_PATH ?? "bash", ["--version"], cwd, env);
    return runtime.ok
      ? probeAdapterFile(
          env.PI_BASH_DEBUG_PATH ?? "/opt/pi-debug-adapters/bash-debug/extension/out/bashDebug.js",
          cwd,
          env,
        )
      : runtime;
  }
  if (id === "powershell-editor-services-debug") {
    const runtime = await probeExecutable(env.PI_PWSH_PATH ?? "pwsh", ["--version"], cwd, env);
    const bundle =
      env.PI_POWERSHELL_EDITOR_SERVICES_PATH ?? "/opt/pi-debug-adapters/powershell-editor-services";
    return runtime.ok
      ? probeAdapterFile(`${bundle}/PowerShellEditorServices/Start-EditorServices.ps1`, cwd, env)
      : runtime;
  }
  const server = env.PI_JS_DEBUG_PATH ?? DEFAULT_JS_DEBUG_PATH;
  try {
    await access(server);
  } catch {
    return { ok: false as const, detail: `${server} does not exist` };
  }
  return probeExecutable(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs'); fs.accessSync(process.argv[1]); console.log(process.version)",
      server,
    ],
    cwd,
    env,
  );
}

async function probeAdapterFile(file: string, cwd: string, env: NodeJS.ProcessEnv) {
  try {
    await access(file);
  } catch {
    return { ok: false as const, detail: `${file} does not exist` };
  }
  return probeExecutable(
    process.execPath,
    ["-e", "const fs=require('node:fs'); fs.accessSync(process.argv[1])", file],
    cwd,
    env,
  );
}
