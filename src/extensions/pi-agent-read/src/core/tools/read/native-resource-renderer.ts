import path from "node:path";
import { homedir } from "node:os";
import {
  createReadToolDefinition,
  getReadmePath,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** The native implementation owns labels, colors, key hints, and expanded text rendering. */
export const nativeReadPresentation = createReadToolDefinition(process.cwd());

/** Shared call/result context from Pi's public tool contract. */
export type ReadRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type NativeArguments = Parameters<NonNullable<typeof nativeReadPresentation.renderCall>>[0];

const contextFiles = new Set([
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
]);

/** Selects native special-file presentation only for native-compatible local read arguments. */
export function nativeReadArguments(
  input: unknown,
  cwd = process.cwd(),
): NativeArguments | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const args = input as { path?: unknown; offset?: unknown; limit?: unknown; views?: unknown };
  const source = args.path;
  if (typeof source !== "string" || source.length === 0 || source.includes("#")) return undefined;
  if (!path.isAbsolute(source) && /^[a-z][a-z\d+.-]*:/iu.test(source)) return undefined;
  if (args.views !== undefined && (!Array.isArray(args.views) || args.views.length > 0))
    return undefined;
  if (
    args.offset !== undefined &&
    (typeof args.offset !== "number" || !Number.isInteger(args.offset) || args.offset < 1)
  )
    return undefined;
  if (
    args.limit !== undefined &&
    (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1)
  )
    return undefined;
  const expanded = source.startsWith("~/") ? path.join(homedir(), source.slice(2)) : source;
  const absolute = path.resolve(cwd, expanded);
  const name = path.basename(absolute);
  const relative = path.relative(path.dirname(getReadmePath()), absolute);
  const docs =
    !path.isAbsolute(relative) &&
    (relative === "README.md" ||
      relative.startsWith(`docs${path.sep}`) ||
      relative.startsWith(`examples${path.sep}`));
  if (name !== "SKILL.md" && !contextFiles.has(name) && !docs) return undefined;
  return {
    path: source,
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  };
}

/** Native renderers reuse Text only; a previous IDE card is a different component type. */
export function nativeReadContext(
  context: ReadRenderContext,
  args: NativeArguments,
): Parameters<NonNullable<typeof nativeReadPresentation.renderCall>>[2] {
  return {
    ...context,
    args,
    lastComponent: context.lastComponent instanceof Text ? context.lastComponent : undefined,
  };
}
