import { readFile } from "node:fs/promises";

import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";
import { probeExecutable } from "pi-agent-doctor/api/executable";

import { hasConfiguredExecutable } from "pi-agent-ide/api/tool-config";

import { parseDocument } from "./ast/manager.js";

import type { DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

const supported = new Set([
  "c",
  "cpp",
  "javascript",
  "typescript",
  "python",
  "rust",
  "json",
  "yaml",
  "toml",
]);

/**
AST health checks owned by the AST plugin.
*/
export const astDoctorPlugin: DoctorPlugin = {
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
        const available = await hasConfiguredExecutable(
          { command: ["ast-grep"] },
          context.cwd,
          context.env,
        );
        return available
          ? {}
          : {
              actions: [
                {
                  id: "ast-grep-unavailable",
                  message: "Structural search is unavailable because ast-grep was not found",
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
          if (!supported.has(language)) {
            continue;
          }

          const file = context.files.find((candidate) => matchesLanguage(candidate, language));

          if (file === undefined) {
            continue;
          }

          try {
            const source = await readFile(file, "utf8");
            const tree = await parseDocument(
              file,
              context.cwd,
              source.replaceAll("\r\n", "\n").split("\n"),
            );
            findings.push(
              tree === undefined
                ? { status: "fail" as const, message: `${language} parser did not return a tree` }
                : { status: "pass" as const, message: `${language} parser loaded`, detail: file },
            );
          } catch (error) {
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

        const result = await probeExecutable("ast-grep", ["--version"], context.cwd, context.env);
        return [
          result.ok
            ? { status: "pass", message: "ast-grep is available", detail: result.detail }
            : { status: "fail", message: "ast-grep is not available", detail: result.detail },
        ];
      },
    });
  },
};

function matchesLanguage(file: string, language: string): boolean {
  const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
  const extensions: Record<string, readonly string[]> = {
    c: [".c", ".h"],
    cpp: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
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
