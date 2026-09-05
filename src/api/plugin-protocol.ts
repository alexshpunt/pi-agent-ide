import type { Diagnostic, IdeTool, ToolContext } from "#src/toolchain/types.js";

export const IDE_PROTOCOL = "pi-agent-ide" as const;

export const IDE_API_VERSION = 3 as const;

export const IDE_CORE_READY_EVENT = "pi-agent-ide/core/ready" as const;

export const IDE_PLUGIN_REGISTER_EVENT = "pi-agent-ide/plugin/register" as const;

export interface IdeCoreReady {
  readonly protocol: typeof IDE_PROTOCOL;
  readonly apiVersion: typeof IDE_API_VERSION;
}

/** One source's result. Ready means complete; snapshot has no completion guarantee, even if empty. */
export interface IdeDiagnosticReport {
  readonly status: "ready" | "snapshot" | "unversioned" | "unavailable";
  readonly diagnostics: readonly Diagnostic[];
  readonly reason?: string;
}

/** Current state of one source, including checks still in progress. */
export interface IdeDiagnosticResult {
  readonly source: string;
  readonly status: IdeDiagnosticReport["status"] | "pending";
  readonly diagnostics: readonly Diagnostic[];
  readonly reason?: string;
}

/** File text and diagnostics read together, so diagnostic coordinates share a source snapshot. */
export interface IdeDiagnosticSnapshot {
  readonly filePath: string;
  readonly content: string;
  readonly results: readonly IdeDiagnosticResult[];
}

/** A revision-bound check. Stop work when aborted; publish may deliver later source updates. */
export interface IdeDiagnosticContext extends ToolContext {
  readonly content: string;
  readonly signal: AbortSignal;
  readonly publish: (report: IdeDiagnosticReport) => void;
}

/** A read-only producer. It must never fix or otherwise write the file. */
export interface IdeDiagnosticSource {
  readonly id: string;
  diagnose(filePath: string, context: IdeDiagnosticContext): Promise<IdeDiagnosticReport>;
}

export interface IdePluginApi {
  addTool(tool: IdeTool): void;
  /** Registers background diagnostics shared by notifications and diagnostic reads. */
  addDiagnosticSource(source: IdeDiagnosticSource): void;
  /** Reuses current results or starts checks, with bounded waiting and explicit readiness. */
  readDiagnostics(filePath: string, context: ToolContext): Promise<IdeDiagnosticSnapshot>;
}

export interface IdePlugin {
  readonly protocol: typeof IDE_PROTOCOL;
  readonly apiVersion: typeof IDE_API_VERSION;
  readonly id: string;
  readonly setup: (api: IdePluginApi) => void | Promise<void>;
}

export interface IdePluginRegistrationRequest {
  readonly plugin: IdePlugin;
  accept(registration: Promise<void>): void;
}

export function isIdeCoreReady(value: unknown): value is IdeCoreReady {
  return isRecord(value) && value.protocol === IDE_PROTOCOL && value.apiVersion === IDE_API_VERSION;
}

export function isIdePlugin(value: unknown): value is IdePlugin {
  return (
    isRecord(value) &&
    value.protocol === IDE_PROTOCOL &&
    value.apiVersion === IDE_API_VERSION &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.setup === "function"
  );
}

export function isIdePluginRegistrationRequest(
  value: unknown,
): value is IdePluginRegistrationRequest {
  return isRecord(value) && isIdePlugin(value.plugin) && typeof value.accept === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
