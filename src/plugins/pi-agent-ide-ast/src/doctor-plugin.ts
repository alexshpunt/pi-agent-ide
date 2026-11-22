import { readFile } from "node:fs/promises";

import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";
import { probeProjectExecutable } from "pi-agent-doctor/api/project-probes";

import { probeLocalAstGrep } from "./ast-grep-binary.ts";
import { withParsedDocument } from "./ast/manager.ts";

import type { DoctorContext, DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";
import type { ExecutableProbeResult } from "pi-agent-doctor/api/executable";

type LocalAstGrepProbe = typeof probeLocalAstGrep;

/** Local projects run the bundled ast-grep; a remote workspace runs the one on its own PATH. */
function probeAstGrep(
  context: DoctorContext,
  probeLocal: LocalAstGrepProbe,
): Promise<ExecutableProbeResult> {
  return context.workspace === undefined
    ? probeLocal(context.cwd, context.env, context.signal)
    : probeProjectExecutable(context, "ast-grep", ["--version"]);
}

const unsupportedReasons: Readonly<Record<string, string>> = {
  cmake: "no compatible Tree-sitter parser is packaged",
  dockerfile: "no compatible Tree-sitter parser is packaged",
  julia: "no compatible Tree-sitter parser is packaged",
  powershell: "no compatible Tree-sitter parser is packaged",
  r: "no compatible Tree-sitter parser is packaged",
  svelte: "the container grammar is not available as an ast-grep language package",
  terraform: "the HCL grammar is not available as an ast-grep language package",
  vue: "the container grammar is not available as an ast-grep language package",
  xml: "no compatible Tree-sitter parser is packaged",
  zig: "no compatible Tree-sitter parser is packaged",
};

const supported = new Set([
  "c",
  "cpp",
  "csharp",
  "css",
  "dart",
  "elixir",
  "go",
  "html",
  "java",
  "kotlin",
  "lua",
  "markdown",
  "php",
  "ruby",
  "scala",
  "shell",
  "sql",
  "swift",
  "javascript",
  "typescript",
  "python",
  "rust",
  "json",
  "yaml",
  "toml",
]);

/**
AST health checks owned by the AST plugin. The local ast-grep probe is injectable for tests.
*/
export function createAstDoctorPlugin(probeLocal: LocalAstGrepProbe): DoctorPlugin {
  return {
    protocol: DOCTOR_PROTOCOL,
    apiVersion: DOCTOR_API_VERSION,
    id: "ast",
    setup(api): void {
      api.addSetupCheck({
        id: "structural-search",
        async inspect(context) {
          if (![...context.detectedLanguageIds].some((language) => supported.has(language))) {
            return {};
          }
          const probe = await probeAstGrep(context, probeLocal);
          return probe.ok
            ? {}
            : {
                actions: [
                  {
                    id: "ast-grep-unavailable",
                    message: `Structural search is unavailable because ast-grep cannot start: ${probe.detail}`,
                  },
                ],
              };
        },
      });
      api.addCheck({
        id: "parsers",
        title: "AST",
        async run(context) {
          const findings = [];

          for (const language of context.detectedLanguageIds) {
            const unsupportedReason = unsupportedReasons[language];
            if (unsupportedReason !== undefined) {
              findings.push({
                status: "skip" as const,
                message: `${language} AST is unavailable: ${unsupportedReason}`,
              });
              continue;
            }
            if (!supported.has(language)) continue;

            const file = context.files.find((candidate) => matchesLanguage(candidate, language));

            if (file === undefined) {
              continue;
            }

            try {
              context.signal?.throwIfAborted();
              const source = context.workspace
                ? await context.workspace.readText(file, context.signal)
                : await readFile(file, { encoding: "utf8", signal: context.signal });
              if (source === undefined) throw new Error(`Source disappeared: ${file}`);
              context.signal?.throwIfAborted();
              const parsed = await withParsedDocument(
                file,
                context.cwd,
                source.replaceAll("\r\n", "\n").split("\n"),
                (tree) => tree !== undefined,
              );
              findings.push(
                !parsed
                  ? { status: "fail" as const, message: `${language} parser did not return a tree` }
                  : { status: "pass" as const, message: `${language} parser loaded`, detail: file },
              );
            } catch (error) {
              context.signal?.throwIfAborted();
              findings.push({
                status: "fail" as const,
                message: `${language}: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }

          return findings.length > 0
            ? findings
            : [{ status: "skip" as const, message: "No supported AST files found" }];
        },
      });
      api.addCheck({
        id: "ast-grep",
        title: "Structural search",
        async run(context) {
          if (![...context.detectedLanguageIds].some((language) => supported.has(language))) {
            return [{ status: "skip", message: "No supported structural-search files found" }];
          }

          const result = await probeAstGrep(context, probeLocal);
          return [
            result.ok
              ? { status: "pass", message: "ast-grep is available", detail: result.detail }
              : {
                  status: "fail",
                  message:
                    context.workspace === undefined
                      ? "ast-grep cannot start; ast_search is not offered"
                      : "ast-grep is not available",
                  detail: result.detail,
                },
          ];
        },
      });
    },
  };
}

export const astDoctorPlugin: DoctorPlugin = createAstDoctorPlugin(probeLocalAstGrep);

function matchesLanguage(file: string, language: string): boolean {
  const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
  const extensions: Record<string, readonly string[]> = {
    c: [".c", ".h"],
    cpp: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
    csharp: [".cs"],
    css: [".css", ".scss", ".less"],
    dart: [".dart"],
    elixir: [".ex", ".exs"],
    go: [".go"],
    html: [".html", ".htm"],
    java: [".java"],
    kotlin: [".kt", ".kts"],
    lua: [".lua"],
    markdown: [".md", ".mdx"],
    php: [".php"],
    ruby: [".rb", ".rake"],
    scala: [".scala", ".sc"],
    shell: [".sh", ".bash"],
    sql: [".sql"],
    swift: [".swift"],
    javascript: [".js", ".jsx", ".mjs", ".cjs"],
    typescript: [".ts", ".tsx", ".mts", ".cts"],
    python: [".py", ".pyi"],
    rust: [".rs"],
    json: [".json", ".jsonc"],
    yaml: [".yaml", ".yml"],
    toml: [".toml"],
  };
  return extensions[language]?.includes(extension) ?? false;
}
