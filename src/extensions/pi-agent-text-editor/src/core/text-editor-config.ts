import { readFileSync } from "node:fs";
import path from "node:path";

export interface TextEditorRecoverySection {
  readonly contextLines: number;
  readonly timeoutMs: number;
  readonly settings: unknown;
}

interface LoadedTextEditorConfig {
  readonly contextLines: number;
  readonly timeoutMs: number;
  readonly sections: Readonly<Record<string, unknown>>;
}

/** Loads generic recovery settings and preserves plugin-owned subsections. */
export function loadTextEditorConfig(cwd: string): LoadedTextEditorConfig {
  const file = path.join(cwd, ".pi", "pi-agent-ide", "text-editor.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return { contextLines: 5, timeoutMs: 2000, sections: {} };
    }
    throw new Error(`Invalid text editor config at ${file}`, { cause: error });
  }
  const root = record(value, "text editor config");
  assertKeys(root, ["recovery", "renderer"], "text editor config");
  if (root.recovery === undefined) {
    return { contextLines: 5, timeoutMs: 2000, sections: {} };
  }
  const recovery = record(root.recovery, "recovery");
  const sections = Object.fromEntries(
    Object.entries(recovery).filter(([key]) => key !== "contextLines" && key !== "timeoutMs"),
  );
  return {
    contextLines: integer(recovery.contextLines, "contextLines", 0, 20, 5),
    timeoutMs: integer(recovery.timeoutMs, "timeoutMs", 1, 10_000, 2000),
    sections,
  };
}

/** Returns one plugin-owned recovery subsection with generic limits. */
export function recoverySection(
  config: LoadedTextEditorConfig,
  name: string,
): TextEditorRecoverySection {
  if (name.length === 0) {
    throw new TypeError("Recovery config section name must be non-empty");
  }
  return {
    contextLines: config.contextLines,
    timeoutMs: config.timeoutMs,
    settings: config.sections[name],
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new TypeError(`${name} contains unknown key ${unknown}`);
  }
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
