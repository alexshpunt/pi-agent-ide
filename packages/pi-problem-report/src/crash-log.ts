import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { stackMentions } from "./guard.ts";

/** One crash as Pi records it in `crashes.json`. */
export interface CrashRecord {
  timestamp: string;
  message: string;
  stack?: string | null;
  /** Pi's version at the time of the crash. */
  version?: string;
  kind?: string;
}

export interface TakeUnreportedCrashesOptions {
  /** Name of the extension; separates its record of offered crashes from other extensions'. */
  readonly source: string;
  /** Folders of the extension's code; a crash counts when a stack frame lies inside one. */
  readonly roots: readonly string[];
  readonly crashLogPath?: string;
  readonly statePath?: string;
  readonly now?: number;
  readonly maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Pi keeps five crashes; this leaves room for records that rotated out of its log. */
const MAX_REMEMBERED = 50;

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

/** Pi's crash log is internal: anything that does not look like its records counts as no crash. */
function readCrashLog(path: string): CrashRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const records: CrashRecord[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const { timestamp, message, stack, version, kind } = record;
    if (typeof timestamp !== "string" || typeof message !== "string") continue;
    if (!optionalString(stack) || !optionalString(version) || !optionalString(kind)) continue;
    records.push({
      timestamp,
      message,
      stack: stack ?? null,
      ...(typeof version === "string" ? { version } : {}),
      ...(typeof kind === "string" ? { kind } : {}),
    });
  }
  return records;
}

function readReported(path: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || !("reported" in value)) return [];
    const reported = value.reported;
    return Array.isArray(reported)
      ? (reported as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function writeReported(path: string, reported: readonly string[]): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ reported }, null, 2)}\n`);
    renameSync(temporary, path);
  } catch {
    // Offering a crash again is harmless.
  }
}

const crashId = (crash: CrashRecord): string => `${crash.timestamp}\n${crash.message}`;

/**
 * Recent crashes from Pi's crash log whose stack points into the extension and that were not
 * returned to this source before. Records what it returns in the extension's own state file;
 * Pi's log and its own notice are left untouched. Best effort: failures return no crashes.
 */
export function takeUnreportedCrashes(options: TakeUnreportedCrashesOptions): CrashRecord[] {
  try {
    const agentDir = (): string => getAgentDir();
    const crashLogPath = options.crashLogPath ?? join(agentDir(), "crashes.json");
    const statePath =
      options.statePath ?? join(agentDir(), "problem-report", `${options.source}.json`);
    const now = options.now ?? Date.now();
    const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const reported = readReported(statePath);
    const seen = new Set(reported);
    const crashes = readCrashLog(crashLogPath).filter((crash) => {
      const age = now - Date.parse(crash.timestamp);
      return (
        Number.isFinite(age) &&
        age <= maxAge &&
        !seen.has(crashId(crash)) &&
        stackMentions(crash.stack ?? undefined, options.roots)
      );
    });
    if (crashes.length > 0)
      writeReported(statePath, [...reported, ...crashes.map(crashId)].slice(-MAX_REMEMBERED));
    return crashes;
  } catch {
    return [];
  }
}

/** An error with the crash's message and stack, for a problem report. */
export function crashError(crash: CrashRecord): Error {
  const error = new Error(crash.message);
  error.stack = crash.stack ?? `Error: ${crash.message}`;
  return error;
}
