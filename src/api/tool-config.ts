import { requiredValue } from "../utils/required-value.js";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
Current on-disk tool configuration version.
*/
export const TOOL_CONFIG_VERSION = 1 as const;

/**
A direct process invocation. Shell expansion is never implicit.
*/
export interface ProcessConfig {
  readonly command: readonly string[];
  readonly cwd?: "project" | "file";
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly successExitCodes?: readonly number[];
}

/**
File selection shared by formatter and linter commands.
*/
export interface FileMatcherConfig {
  readonly extensions: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

/**
A formatter command that writes in place or returns formatted text.
*/
export interface FormatterCommandConfig extends FileMatcherConfig {
  readonly run: ProcessConfig;
  readonly output: "in-place" | "stdout";
}

/**
Versioned project formatter configuration.
*/
export interface FormattersConfig {
  readonly version: typeof TOOL_CONFIG_VERSION;
  readonly formatters: Readonly<Record<string, FormatterCommandConfig>>;
}

export type DiagnosticFormat =
  | "pi-json"
  | "eslint-json"
  | "sarif"
  | "checkstyle"
  | "gcc"
  | "clang"
  | "regex";

/**
Describes how a linter's output becomes Pi Agent IDE diagnostics.
*/
export interface DiagnosticParserConfig {
  readonly format: DiagnosticFormat;
  readonly pattern?: string;
}

/**
A linter with separate read-only and optional fixing commands.
*/
export interface LinterCommandConfig extends FileMatcherConfig {
  readonly check: ProcessConfig;
  readonly fix?: ProcessConfig;
  readonly diagnostics: DiagnosticParserConfig;
}

/**
Versioned project linter configuration.
*/
export interface LintersConfig {
  readonly version: typeof TOOL_CONFIG_VERSION;
  readonly linters: Readonly<Record<string, LinterCommandConfig>>;
}

/**
Captured result from a configured process.
*/
export interface ProcessResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
Resolves the project-local Pi Agent IDE configuration directory.
*/
export function projectIdeConfigDirectory(projectRoot: string): string {
  return path.join(projectRoot, ".pi", "pi-agent-ide");
}

/**
Resolves a named project-local Pi Agent IDE JSON file.
*/
export function projectIdeConfigPath(
  projectRoot: string,
  name: "formatters" | "linters" | "lsp-servers",
): string {
  return path.join(projectIdeConfigDirectory(projectRoot), `${name}.json`);
}

/**
Returns whether a configured matcher accepts a project file.
*/
export function matchesConfiguredFile(
  config: FileMatcherConfig,
  filePath: string,
  projectRoot: string,
): boolean {
  const extension = path.extname(filePath).toLowerCase();

  if (
    config.extensions.every(
      (candidate) => !(normalizeExtension(candidate) === extension || candidate === "*"),
    )
  ) {
    return false;
  }

  const relative = path.relative(projectRoot, filePath).split(path.sep).join("/");
  const matches = (patterns: readonly string[] | undefined): boolean =>
    patterns?.some((pattern) => path.matchesGlob(relative, pattern)) ?? false;

  return (config.include === undefined || matches(config.include)) && !matches(config.exclude);
}

/**
Runs a configured process after expanding file and project placeholders.
*/
export async function runConfiguredProcess(
  config: ProcessConfig,
  context: {
    readonly projectRoot: string;
    readonly filePath: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<ProcessResult> {
  assertProcessConfig(config, "process");
  const command = config.command.map((part) => expandPlaceholders(part, context));
  const executable = requiredValue(command[0]);
  const arguments_ = command.slice(1);
  const cwd = config.cwd === "file" ? path.dirname(context.filePath) : context.projectRoot;
  const accepted = config.successExitCodes ?? [0];

  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env: { ...(context.env ?? process.env), ...config.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let isTimedOut = false;
    const timeout = setTimeout(() => {
      isTimedOut = true;
      child.kill("SIGKILL");
    }, config.timeoutMs ?? 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        ok: !isTimedOut && exitCode !== null && accepted.includes(exitCode),
        exitCode,
        stdout,
        stderr,
      });
    });
  });
}

/**
Runs a formatter command and writes stdout mode back to the source file.
*/
export async function runConfiguredFormatter(
  config: FormatterCommandConfig,
  context: {
    readonly projectRoot: string;
    readonly filePath: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<{ readonly ok: boolean; readonly changed: boolean }> {
  const before = await readFile(context.filePath, "utf8");
  const result = await runConfiguredProcess(config.run, context);

  if (!result.ok) {
    return { ok: false, changed: false };
  }

  if (config.output === "stdout" && result.stdout !== before) {
    await writeFile(context.filePath, result.stdout, "utf8");
  }

  const after = await readFile(context.filePath, "utf8");
  return { ok: true, changed: before !== after };
}

/**
Validates and returns a formatter configuration object.
*/
export function parseFormattersConfig(value: unknown): FormattersConfig {
  const root = configRoot(value, "formatters");

  for (const [name, entry] of Object.entries(root.entries)) {
    const record = configRecord(entry, `formatter ${name}`);
    assertMatcher(record, `formatter ${name}`);
    assertProcessConfig(record.run, `formatter ${name}.run`);

    if (record.output !== "in-place" && record.output !== "stdout") {
      throw new Error(`formatter ${name}.output must be in-place or stdout`);
    }
  }

  return value as FormattersConfig;
}

/**
Validates and returns a linter configuration object.
*/
export function parseLintersConfig(value: unknown): LintersConfig {
  const root = configRoot(value, "linters");
  const formats: ReadonlySet<string> = new Set([
    "pi-json",
    "eslint-json",
    "sarif",
    "checkstyle",
    "gcc",
    "clang",
    "regex",
  ]);

  for (const [name, entry] of Object.entries(root.entries)) {
    const record = configRecord(entry, `linter ${name}`);
    assertMatcher(record, `linter ${name}`);
    assertProcessConfig(record.check, `linter ${name}.check`);

    if (record.fix !== undefined) {
      assertProcessConfig(record.fix, `linter ${name}.fix`);
    }

    const diagnostics = configRecord(record.diagnostics, `linter ${name}.diagnostics`);

    if (!formats.has(String(diagnostics.format))) {
      throw new Error(`linter ${name} has an unsupported diagnostics format`);
    }

    if (diagnostics.format === "regex" && typeof diagnostics.pattern !== "string") {
      throw new Error(`linter ${name} regex diagnostics require pattern`);
    }
  }

  return value as LintersConfig;
}

function configRoot(
  value: unknown,
  key: "formatters" | "linters",
): { readonly entries: Record<string, unknown> } {
  const root = configRecord(value, "tool config");

  if (root.version !== TOOL_CONFIG_VERSION) {
    throw new Error(`tool config version must be ${TOOL_CONFIG_VERSION}`);
  }

  const entries = configRecord(root[key], key);
  return { entries };
}

function assertMatcher(record: Record<string, unknown>, label: string): void {
  assertStringArray(record.extensions, `${label}.extensions`, false);

  if (record.include !== undefined) {
    assertStringArray(record.include, `${label}.include`, false);
  }

  if (record.exclude !== undefined) {
    assertStringArray(record.exclude, `${label}.exclude`, true);
  }
}

function assertProcessConfig(value: unknown, label: string): asserts value is ProcessConfig {
  const record = configRecord(value, label);
  assertStringArray(record.command, `${label}.command`, false);

  if (record.cwd !== undefined && record.cwd !== "project" && record.cwd !== "file") {
    throw new Error(`${label}.cwd must be project or file`);
  }

  if (
    record.timeoutMs !== undefined &&
    (!Number.isFinite(record.timeoutMs) || Number(record.timeoutMs) <= 0)
  ) {
    throw new Error(`${label}.timeoutMs must be positive`);
  }

  if (
    record.successExitCodes !== undefined &&
    (!Array.isArray(record.successExitCodes) ||
      record.successExitCodes.some((code) => !Number.isInteger(code)))
  ) {
    throw new Error(`${label}.successExitCodes must contain integers`);
  }

  if (record.env !== undefined) {
    const environment = configRecord(record.env, `${label}.env`);

    if (Object.values(environment).some((item) => typeof item !== "string")) {
      throw new Error(`${label}.env values must be strings`);
    }
  }
}

function assertStringArray(
  value: unknown,
  label: string,
  allowEmpty: boolean,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array of strings`);
  }
}

function configRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function normalizeExtension(extension: string): string {
  return extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
}

function expandPlaceholders(
  value: string,
  context: { readonly projectRoot: string; readonly filePath: string },
): string {
  const relativeFile = path.relative(context.projectRoot, context.filePath);
  return value
    .replaceAll("{project}", context.projectRoot)
    .replaceAll("{fileDir}", path.dirname(context.filePath))
    .replaceAll("{relativeFile}", relativeFile)
    .replaceAll("{file}", context.filePath);
}
