import type { ToolRecipe } from "pi-agent-doctor/api/catalog";

/** One executable language and the debug adapter selected for its Linux verification track. */
export interface DebuggerLanguageMatrixEntry {
  readonly language: string;
  readonly backend: string;
  readonly status: "planned" | "verified";
}

/** Complete Linux debugger scope. Planned entries are not advertised as working recipes. */
export const DEBUGGER_LANGUAGE_MATRIX: readonly DebuggerLanguageMatrixEntry[] = [
  { language: "c", backend: "lldb-dap", status: "verified" },
  { language: "cpp", backend: "lldb-dap", status: "verified" },
  { language: "csharp", backend: "netcoredbg", status: "verified" },
  { language: "dart", backend: "dart debug_adapter", status: "verified" },
  { language: "elixir", backend: "elixir-ls", status: "verified" },
  { language: "go", backend: "dlv dap", status: "verified" },
  { language: "java", backend: "kotlin-debug-adapter", status: "verified" },
  { language: "javascript", backend: "vscode-js-debug", status: "verified" },
  { language: "julia", backend: "DebugAdapter.jl", status: "verified" },
  { language: "kotlin", backend: "kotlin-debug-adapter", status: "verified" },
  { language: "lua", backend: "local-lua-debugger-vscode", status: "verified" },
  { language: "php", backend: "vscode-php-debug", status: "verified" },
  { language: "powershell", backend: "PowerShellEditorServices", status: "verified" },
  { language: "python", backend: "debugpy", status: "verified" },
  { language: "r", backend: "vscDebugger", status: "verified" },
  { language: "ruby", backend: "rdbg", status: "verified" },
  { language: "rust", backend: "lldb-dap", status: "verified" },
  { language: "shell", backend: "bash-debug-adapter", status: "verified" },
  { language: "swift", backend: "lldb-dap", status: "verified" },
  { language: "typescript", backend: "vscode-js-debug", status: "verified" },
  { language: "zig", backend: "lldb-dap", status: "verified" },
];

/** Debug adapter recipes that Pi Agent IDE currently verifies on provisioned Linux hosts. */
export const DEBUGGER_RECIPES: readonly ToolRecipe[] = [
  {
    id: "dart-debug-adapter",
    name: "Dart debug adapter",
    kind: "debugger",
    languages: ["dart"],
    executables: ["dart"],
    dependencies: ["Dart SDK 3.13.3"],
    documentation: "https://github.com/dart-lang/sdk/tree/main/third_party/pkg/dap",
    debugger: {
      runtimeExecutables: ["dart"],
      adapterExecutables: ["dart"],
      platforms: ["linux", "win32"],
      install: "Install Dart SDK 3.13.3 from the official Dart archive.",
    },
  },
  {
    id: "debugpy",
    name: "debugpy",
    kind: "debugger",
    languages: ["python"],
    executables: ["python3"],
    dependencies: ["debugpy"],
    documentation: "https://github.com/microsoft/debugpy",
    debugger: {
      runtimeExecutables: ["python3"],
      adapterExecutables: ["python3"],
      platforms: ["linux", "win32"],
      install: "Install Python 3 and debugpy for that interpreter.",
    },
  },
  {
    id: "delve",
    name: "Delve",
    kind: "debugger",
    languages: ["go"],
    executables: ["dlv"],
    dependencies: ["github.com/go-delve/delve/cmd/dlv@v1.25.2"],
    documentation: "https://github.com/go-delve/delve/tree/master/Documentation/api/dap",
    debugger: {
      runtimeExecutables: ["go"],
      adapterExecutables: ["dlv"],
      platforms: ["linux", "win32"],
      install: "Install Go and Delve. Native Windows support requires amd64.",
    },
  },
  {
    id: "elixir-ls-debug-adapter",
    name: "ElixirLS debug adapter",
    kind: "debugger",
    languages: ["elixir"],
    executables: ["elixir", "mix"],
    dependencies: ["Elixir", "Erlang/OTP", "ElixirLS 0.31.1"],
    documentation: "https://github.com/elixir-lsp/elixir-ls",
    debugger: {
      runtimeExecutables: ["elixir", "mix"],
      adapterExecutables: ["debug_adapter.sh", "debug_adapter.bat"],
      platforms: ["linux", "win32"],
      install:
        "Install compatible Erlang/OTP and Elixir releases plus ElixirLS 0.31.1. Use debug_adapter.bat on Windows.",
    },
  },
  {
    id: "vsc-debugger",
    name: "vscDebugger",
    kind: "debugger",
    languages: ["r"],
    executables: ["R"],
    dependencies: ["R 4.5.3", "R6 2.6.1", "jsonlite 2.0.0", "vscDebugger 0.5.9"],
    documentation: "https://manuelhentschel.github.io/vscDebugger/",
    debugger: {
      runtimeExecutables: ["R"],
      adapterExecutables: ["R"],
      platforms: ["linux", "win32"],
      install: "Install R 4.5.3 and vscDebugger 0.5.9 for that R installation.",
    },
  },
  {
    id: "julia-debug-adapter",
    name: "DebugAdapter.jl",
    kind: "debugger",
    languages: ["julia"],
    executables: ["julia"],
    dependencies: ["Julia 1.13.0", "DebugAdapter.jl 3.2.1"],
    documentation: "https://github.com/julia-vscode/DebugAdapter.jl",
    debugger: {
      runtimeExecutables: ["julia"],
      adapterExecutables: ["julia"],
      platforms: ["linux"],
      install:
        "Install Julia 1.13.0 and add DebugAdapter.jl 3.2.1 to /opt/pi-debug-adapters/julia.",
    },
  },
  {
    id: "kotlin-debug-adapter",
    name: "Kotlin Debug Adapter",
    kind: "debugger",
    languages: ["java", "kotlin"],
    executables: ["kotlin-debug-adapter"],
    dependencies: [
      "fwcd/kotlin-debug-adapter 0.4.4",
      "Temurin JDK 21.0.8+9",
      "Kotlin compiler 2.2.20 for Kotlin builds",
    ],
    documentation: "https://github.com/fwcd/kotlin-debug-adapter",
    debugger: {
      runtimeExecutables: ["java"],
      adapterExecutables: ["kotlin-debug-adapter"],
      platforms: ["linux"],
      install:
        "Install Temurin JDK 21.0.8+9 and fwcd/kotlin-debug-adapter 0.4.4. Compile the target with debug information before launching it.",
    },
  },
  {
    id: "netcoredbg",
    name: "NetCoreDbg",
    kind: "debugger",
    languages: ["csharp"],
    executables: ["netcoredbg"],
    dependencies: ["Samsung/netcoredbg 3.2.0-1092", ".NET SDK 8"],
    documentation: "https://github.com/Samsung/netcoredbg",
    debugger: {
      runtimeExecutables: ["dotnet"],
      adapterExecutables: ["netcoredbg"],
      platforms: ["linux", "win32"],
      install:
        "Install .NET SDK 8 and NetCoreDbg 3.2.0-1092. On Windows, ensure the selected dotnet SDK is on PATH.",
    },
  },
  {
    id: "lldb-dap",
    name: "lldb-dap",
    kind: "debugger",
    languages: ["c", "cpp", "rust"],
    executables: ["lldb-dap-18", "lldb-dap"],
    dependencies: ["lldb-18"],
    documentation: "https://lldb.llvm.org/use/lldbdap.html",
    debugger: {
      runtimeExecutables: [],
      adapterExecutables: ["lldb-dap-18", "lldb-dap"],
      platforms: ["linux"],
      install: "Install LLDB 18 and compile the target with debug information.",
    },
  },
  {
    id: "lldb-dap-swift",
    name: "lldb-dap for Swift",
    kind: "debugger",
    languages: ["swift"],
    executables: ["lldb-dap"],
    dependencies: ["Swift 6.3.3 toolchain"],
    documentation: "https://lldb.llvm.org/use/lldbdap.html",
    debugger: {
      runtimeExecutables: ["swiftc"],
      adapterExecutables: ["lldb-dap"],
      platforms: ["linux"],
      install:
        "Install the official Swift 6.3.3 Linux toolchain, which includes swiftc and lldb-dap.",
    },
  },
  {
    id: "lldb-dap-zig",
    name: "lldb-dap for Zig",
    kind: "debugger",
    languages: ["zig"],
    executables: ["lldb-dap-18", "lldb-dap"],
    dependencies: ["Zig 0.15.2", "lldb-18"],
    documentation: "https://lldb.llvm.org/use/lldbdap.html",
    debugger: {
      runtimeExecutables: ["zig"],
      adapterExecutables: ["lldb-dap-18", "lldb-dap"],
      platforms: ["linux", "win32"],
      install:
        "Install Zig 0.15.2 and LLDB 18, then compile the target in Debug mode with the LLVM backend (-fllvm) so LLDB can inspect locals.",
    },
  },
  {
    id: "local-lua-debugger",
    name: "Local Lua Debugger",
    kind: "debugger",
    languages: ["lua"],
    executables: ["lua", "node"],
    dependencies: ["local-lua-debugger-vscode 0.3.3"],
    documentation: "https://github.com/tomblind/local-lua-debugger-vscode",
    debugger: {
      runtimeExecutables: ["lua", "node"],
      adapterExecutables: ["debugAdapter.js"],
      platforms: ["linux", "win32"],
      install: "Install Lua 5.3, Node 24, and local-lua-debugger-vscode 0.3.3.",
    },
  },
  {
    id: "powershell-editor-services-debug",
    name: "PowerShell Editor Services",
    kind: "debugger",
    languages: ["powershell"],
    executables: ["pwsh"],
    dependencies: ["PowerShellEditorServices 4.7.0"],
    documentation: "https://github.com/PowerShell/PowerShellEditorServices",
    debugger: {
      runtimeExecutables: ["pwsh"],
      adapterExecutables: ["Start-EditorServices.ps1"],
      platforms: ["linux", "win32"],
      install: "Install PowerShell 7.4.13 and PowerShellEditorServices 4.7.0.",
    },
  },
  {
    id: "rdbg",
    name: "rdbg",
    kind: "debugger",
    languages: ["ruby"],
    executables: ["rdbg"],
    dependencies: ["debug gem 1.11.0 or newer"],
    documentation: "https://github.com/ruby/debug",
    debugger: {
      runtimeExecutables: ["ruby"],
      adapterExecutables: ["rdbg", "rdbg.bat"],
      platforms: ["linux", "win32"],
      install: "Install Ruby and debug gem 1.11.0 or newer.",
    },
  },
  {
    id: "vscode-bash-debug",
    name: "Bash Debug",
    kind: "debugger",
    languages: ["shell"],
    executables: ["bash", "node"],
    dependencies: ["Bash Debug 0.3.9"],
    documentation: "https://github.com/rogalmic/vscode-bash-debug",
    debugger: {
      runtimeExecutables: ["bash", "node"],
      adapterExecutables: ["bashDebug.js"],
      platforms: ["linux"],
      install: "Install Bash, Node 24, and Bash Debug 0.3.9.",
    },
  },
  {
    id: "vscode-php-debug",
    name: "PHP Debug",
    kind: "debugger",
    languages: ["php"],
    executables: ["php", "node"],
    dependencies: ["PHP Debug 1.40.1", "Xdebug"],
    documentation: "https://github.com/xdebug/vscode-php-debug",
    debugger: {
      runtimeExecutables: ["php", "node"],
      adapterExecutables: ["phpDebug.js"],
      platforms: ["linux", "win32"],
      install: "Install PHP with Xdebug, Node 24, and PHP Debug 1.40.1.",
    },
  },
  {
    id: "vscode-js-debug",
    name: "vscode-js-debug",
    kind: "debugger",
    languages: ["javascript", "typescript"],
    executables: ["node"],
    dependencies: ["@vscode/js-debug"],
    documentation: "https://github.com/microsoft/vscode-js-debug",
    debugger: {
      runtimeExecutables: ["node"],
      adapterExecutables: ["dapDebugServer.js"],
      platforms: ["linux", "win32"],
      install: "Install Node 24 and js-debug-dap v1.117.0 from the official release archive.",
    },
  },
];

/** Return the verified debugger recipe for one detected executable language. */
export function debuggerRecipeForLanguage(languageId: string): ToolRecipe | undefined {
  return DEBUGGER_RECIPES.find((recipe) => recipe.languages.includes(languageId));
}
