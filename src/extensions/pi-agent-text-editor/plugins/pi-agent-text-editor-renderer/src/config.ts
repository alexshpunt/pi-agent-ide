import { readFileSync } from "node:fs";
import path from "node:path";

/** How a mutation diff panel picks its viewport. */
export type DiffViewMode = "full" | "compact";

/** Renderer behaviour settings. */
export interface RendererConfig {
  readonly diffView: DiffViewMode;
}

/** Default renderer policy: show the whole diff as a growing viewport. */
export const DEFAULT_RENDERER_CONFIG: RendererConfig = { diffView: "full" };

/** Validates the renderer subsection of `.pi/pi-agent-ide/text-editor.json`. */
export function parseRendererConfig(section: unknown): RendererConfig {
  const renderer = optionalObject(section, "renderer");
  if (renderer !== undefined) {
    assertKeys(renderer, ["diffView"], "renderer");
  }
  const value = renderer?.diffView;
  if (value === undefined) {
    return DEFAULT_RENDERER_CONFIG;
  }
  if (value !== "full" && value !== "compact") {
    throw new TypeError('renderer.diffView must be "full" or "compact"');
  }
  return { diffView: value };
}

/** Loads the same config contract without a running text-editor core. */
export function loadRendererConfig(cwd: string): RendererConfig {
  const file = path.join(cwd, ".pi", "pi-agent-ide", "text-editor.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return DEFAULT_RENDERER_CONFIG;
    }
    throw new Error(`Invalid text editor config at ${file}`, { cause: error });
  }
  const root = objectRecord(parsed, "text editor config");
  assertKeys(root, ["recovery", "renderer"], "text editor config");
  return parseRendererConfig(root.renderer);
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

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
