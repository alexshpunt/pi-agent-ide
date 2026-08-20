import type { LanguageDefinition, ToolRecipe } from "./catalog.js";

/**
Shared protocol identifier.
*/
export const DOCTOR_PROTOCOL = "pi-agent-ide-doctor" as const;

/**
Current doctor contribution API version.
*/
export const DOCTOR_API_VERSION = 1 as const;

/**
Event emitted when the doctor core can accept plugins.
*/
export const DOCTOR_CORE_READY_EVENT = "pi-agent-ide-doctor/core/ready" as const;

/**
Event used by independent doctor plugins to register.
*/
export const DOCTOR_PLUGIN_REGISTER_EVENT = "pi-agent-ide-doctor/plugin/register" as const;

/**
Severity of one doctor finding.
*/
export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

/**
One redacted user-facing check result.
*/
export interface DoctorFinding {
  readonly status: DoctorStatus;
  readonly message: string;
  readonly detail?: string;
}

/**
Project facts passed to an independent check.
*/
export interface DoctorContext {
  readonly cwd: string;
  readonly files: readonly string[];
  readonly detectedLanguageIds: ReadonlySet<string>;
  readonly env: NodeJS.ProcessEnv;
}

/**
A health check owned by one plugin.
*/
export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  readonly run: (context: DoctorContext) => Promise<readonly DoctorFinding[]>;
}

/**
Contribution API available only during plugin setup.
*/
export interface DoctorPluginApi {
  addLanguage(language: LanguageDefinition): void;
  addToolRecipe(recipe: ToolRecipe): void;
  addCheck(check: DoctorCheck): void;
}

/**
Independent doctor contribution.
*/
export interface DoctorPlugin {
  readonly protocol: typeof DOCTOR_PROTOCOL;
  readonly apiVersion: typeof DOCTOR_API_VERSION;
  readonly id: string;
  readonly setup: (api: DoctorPluginApi) => void | Promise<void>;
}

/**
Registration request sent over Pi's shared event bus.
*/
export interface DoctorPluginRegistrationRequest {
  readonly plugin: DoctorPlugin;
  accept(registration: Promise<void>): void;
}

/**
Core readiness event payload.
*/
export interface DoctorCoreReady {
  readonly protocol: typeof DOCTOR_PROTOCOL;
  readonly apiVersion: typeof DOCTOR_API_VERSION;
}

/**
Returns whether a value announces a compatible doctor core.
*/
export function isDoctorCoreReady(value: unknown): value is DoctorCoreReady {
  return (
    isRecord(value) && value.protocol === DOCTOR_PROTOCOL && value.apiVersion === DOCTOR_API_VERSION
  );
}

/**
Returns whether a value contains a valid plugin registration request.
*/
export function isDoctorPluginRegistrationRequest(
  value: unknown,
): value is DoctorPluginRegistrationRequest {
  if (!isRecord(value) || typeof value.accept !== "function" || !isRecord(value.plugin)) {
    return false;
  }

  return (
    value.plugin.protocol === DOCTOR_PROTOCOL &&
    value.plugin.apiVersion === DOCTOR_API_VERSION &&
    typeof value.plugin.id === "string" &&
    value.plugin.id.length > 0 &&
    typeof value.plugin.setup === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
