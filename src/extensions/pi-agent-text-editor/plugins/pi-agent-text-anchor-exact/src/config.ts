import { readFileSync } from "node:fs";
import path from "node:path";

import type { TextEditorRecoveryConfigSection } from "pi-agent-text-editor/api/plugin-protocol";

/** Validated limits used by Exact text recovery. */
export interface ExactTextRecoveryConfig {
  readonly fuzzyEnabled: boolean;
  readonly threshold: number;
  readonly exactCandidateLimit: number;
  readonly fuzzyCandidateLimit: number;
  readonly maxFileSizeMiB: number;
  readonly maxQuerySizeKiB: number;
  readonly seedLimit: number;
  readonly blockLineVariance: number;
  readonly contextLines: number;
  readonly timeoutMs: number;
}

/** Default conservative recovery policy. */
export const DEFAULT_EXACT_TEXT_RECOVERY_CONFIG: ExactTextRecoveryConfig = {
  fuzzyEnabled: true,
  threshold: 0.8,
  exactCandidateLimit: 20,
  fuzzyCandidateLimit: 5,
  maxFileSizeMiB: 20,
  maxQuerySizeKiB: 1024,
  seedLimit: 3,
  blockLineVariance: 2,
  contextLines: 5,
  timeoutMs: 2000,
};

/** Validates the Exact text plugin's recovery subsection. */
export function parseExactTextRecoveryConfig(
  section: TextEditorRecoveryConfigSection,
): ExactTextRecoveryConfig {
  const exact = optionalObject(section.settings, "recovery.exactText");
  if (exact !== undefined) {
    assertKeys(
      exact,
      [
        "fuzzyEnabled",
        "threshold",
        "exactCandidateLimit",
        "fuzzyCandidateLimit",
        "maxFileSizeMiB",
        "maxQuerySizeKiB",
        "seedLimit",
        "blockLineVariance",
      ],
      "recovery.exactText",
    );
  }
  const value = (key: string): unknown => (exact === undefined ? undefined : exact[key]);
  return {
    fuzzyEnabled: optionalBoolean(value("fuzzyEnabled"), "fuzzyEnabled") ?? true,
    threshold: optionalNumber(value("threshold"), "threshold", 0, 1) ?? 0.8,
    exactCandidateLimit:
      optionalInteger(value("exactCandidateLimit"), "exactCandidateLimit", 1, 100) ?? 20,
    fuzzyCandidateLimit:
      optionalInteger(value("fuzzyCandidateLimit"), "fuzzyCandidateLimit", 1, 20) ?? 5,
    maxFileSizeMiB: optionalNumber(value("maxFileSizeMiB"), "maxFileSizeMiB", 0.01, 100) ?? 20,
    maxQuerySizeKiB:
      optionalNumber(value("maxQuerySizeKiB"), "maxQuerySizeKiB", 0.01, 4096) ?? 1024,
    seedLimit: optionalInteger(value("seedLimit"), "seedLimit", 1, 10) ?? 3,
    blockLineVariance: optionalInteger(value("blockLineVariance"), "blockLineVariance", 0, 10) ?? 2,
    contextLines: section.contextLines,
    timeoutMs: section.timeoutMs,
  };
}

/** Loads the same config contract without a running text-editor core. */
export function loadExactTextRecoveryConfig(cwd: string): ExactTextRecoveryConfig {
  const file = path.join(cwd, ".pi", "pi-agent-ide", "text-editor.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return DEFAULT_EXACT_TEXT_RECOVERY_CONFIG;
    }
    throw new Error(`Invalid text editor config at ${file}`, { cause: error });
  }
  const root = objectRecord(parsed, "text editor config");
  assertKeys(root, ["recovery", "renderer"], "text editor config");
  const recovery = optionalObject(root.recovery, "recovery");
  if (recovery === undefined) {
    return DEFAULT_EXACT_TEXT_RECOVERY_CONFIG;
  }
  assertKeys(recovery, ["contextLines", "timeoutMs", "exactText"], "recovery");
  return parseExactTextRecoveryConfig({
    contextLines: optionalInteger(recovery.contextLines, "contextLines", 0, 20) ?? 5,
    timeoutMs: optionalInteger(recovery.timeoutMs, "timeoutMs", 1, 10_000) ?? 2000,
    settings: recovery.exactText,
  });
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalObject(value: unknown, name: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : objectRecord(value, name);
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`${name} contains unknown key ${unknown}`);
  }
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  throw new TypeError(`${name} must be a boolean`);
}

function optionalNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const number = optionalNumber(value, name, minimum, maximum);
  if (number !== undefined && !Number.isInteger(number)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return number;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
