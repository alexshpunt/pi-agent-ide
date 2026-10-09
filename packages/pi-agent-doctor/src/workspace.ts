import type { Readable, Writable } from "node:stream";
import type { ProcessRecipe, ToolRecipe } from "./catalog.js";
import type { RecipeEvidence } from "./evidence.js";

/** Public managed runtime/adapter path overrides. No credentials or general environment are exposed. */
export const DOCTOR_TOOL_PATH_KEYS = [
  "PI_PYTHON_PATH",
  "PI_JS_DEBUG_PATH",
  "PI_ELIXIR_LS_DEBUG_PATH",
  "PI_R_PATH",
  "PI_LLDB_DAP_PATH",
  "PI_DELVE_PATH",
  "PI_KOTLIN_DEBUG_ADAPTER_PATH",
  "PI_JULIA_DEBUG_PROJECT",
  "PI_DART_PATH",
  "PI_JULIA_PATH",
  "PI_NETCOREDBG_PATH",
  "PI_RUBY_DEBUG_PATH",
  "PI_PHP_PATH",
  "PI_PHP_DEBUG_PATH",
  "PI_LUA_PATH",
  "PI_LUA_DEBUG_PATH",
  "PI_BASH_PATH",
  "PI_BASH_DEBUG_PATH",
  "PI_PWSH_PATH",
  "PI_POWERSHELL_EDITOR_SERVICES_PATH",
] as const;
export type DoctorToolPathKey = (typeof DOCTOR_TOOL_PATH_KEYS)[number];

/** A configured command executed without a shell on the selected project owner. */
export interface DoctorCommand extends ProcessRecipe {
  readonly cwd?: "project" | "file";
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Captured native command result. A missing exit report is never success. */
export interface DoctorProcessResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Owned stdio for a long-lived probe, with awaited cleanup. */
export interface DoctorOwnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly completion: Promise<{ readonly exitCode: number | null }>;
  readonly remote: { readonly target: string; readonly pid: number };
  stop(): Promise<void>;
}

/** Files, configuration and process probes on one explicit project owner. */
export interface DoctorWorkspace {
  /** Native public tool path overrides, never values copied from the controller. */
  readonly toolPaths?: Readonly<Partial<Record<DoctorToolPathKey, string>>>;
  /** Check target browser dependencies and startup without opening a URL or using a shared profile. */
  readonly probeBrowser?: (
    signal?: AbortSignal,
  ) => Promise<{ readonly ok: boolean; readonly detail: string }>;
  /** Check the native graphics connection and libraries without pixels or changing capture opt-in. */
  readonly probeCapture?: (signal?: AbortSignal) => Promise<{
    readonly display: { readonly ok: boolean; readonly detail: string };
    readonly window: { readonly ok: boolean; readonly detail: string };
  }>;
  readonly source: string;
  readonly platform: NodeJS.Platform;
  files(signal?: AbortSignal): Promise<readonly string[]>;
  readText(source: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Require the previously read content, or absence when previous is undefined. */
  writeText(
    source: string,
    content: string,
    previous: string | undefined,
    signal?: AbortSignal,
  ): Promise<void>;
  configPaths(
    name: "formatters" | "linters" | "lsp-servers",
    signal?: AbortSignal,
  ): Promise<{ project: string; global: string }>;
  exists(source: string, signal?: AbortSignal): Promise<boolean>;
  evidence(
    recipes: readonly ToolRecipe[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, RecipeEvidence>>;
  executableAvailability(
    configs: readonly DoctorCommand[],
    signal?: AbortSignal,
  ): Promise<readonly boolean[]>;
  run(config: DoctorCommand, source: string, signal?: AbortSignal): Promise<DoctorProcessResult>;
  /** Copy only this source to an owned temporary probe and await removal after use. */
  withProbeCopy<T>(
    source: string,
    use: (probe: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  start(
    command: readonly string[],
    env: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<DoctorOwnedProcess>;
  toNativeUri(source: string): string;
  fromNativeUri(source: string): string;
}
