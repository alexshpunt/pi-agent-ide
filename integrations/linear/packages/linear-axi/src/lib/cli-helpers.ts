import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { usage } from "#axi/args.ts";
import type { InputRecord, ParsedFlags } from "#axi/types.ts";
import { valueText } from "./value-text.ts";

export const TOOL_BOOLEAN_FLAGS = [
  "includeArchived",
  "includeMembers",
  "includeMilestones",
  "includeStages",
  "includeTeams",
];

export function appendContinuationHelp(
  help: string[],
  baseCommand: string,
  parsed: InputRecord,
  flagNames: readonly string[],
  cursor: string | undefined,
): string[] {
  if (!cursor) return help;
  const parts = [baseCommand];
  for (const name of flagNames) {
    if (parsed[name] === undefined) continue;
    appendFlag(parts, name, parsed[name]);
  }
  appendFlag(parts, "cursor", cursor);
  help.push(`Run \`${parts.join(" ")}\` to continue`);
  return help;
}

export function formatCommandArg(value: unknown): string {
  const text = valueText(value);
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

export function collectKnownArgs(parsed: InputRecord, names: readonly string[]): InputRecord {
  const collected: InputRecord = {};
  for (const name of names) {
    if (parsed[name] !== undefined) collected[name] = coerceArg(name, parsed[name]);
  }
  return collected;
}

export function rejectIdOnCreate(resource: string, help: string[], parsed: ParsedFlags): void {
  if (parsed.id !== undefined) {
    const article = /^[aeiou]/i.test(resource) ? "an" : "a";
    throw usage(`creating ${article} ${resource} does not accept --id`, help);
  }
}

export function requireValue<T>(
  value: T,
  message: string,
  help: string[],
): asserts value is NonNullable<T> {
  if (!value) throw usage(message, help);
}

export function requireTeam(parsed: ParsedFlags, help: string[]): string {
  const team = parsed.teamId ?? parsed.team;
  if (typeof team !== "string" || !team) throw usage("--team is required", help);
  return team;
}

interface CommandGroup {
  name: string;
  help(): string;
  handlers: Readonly<Record<string, (args: string[]) => string | Promise<string>>>;
  unknownHelp: string[];
  defaultSubcommand?: string;
}

export function dispatchCommandGroup(
  args: string[],
  options: CommandGroup,
): string | Promise<string> {
  const subcommand = args.at(0);
  if (subcommand === "--help" || subcommand === "-h") return options.help();

  const name = subcommand ?? options.defaultSubcommand ?? "list";
  if (Object.hasOwn(options.handlers, name)) return options.handlers[name](args.slice(1));

  throw usage(`unknown ${options.name} command: ${subcommand ?? ""}`.trim(), options.unknownHelp);
}

export function parseFiniteNumber(name: string, value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw usage(`--${name} must be a finite number`, [`Run \`linear-axi --help\``]);
  }
  return number;
}

export async function readTextFlag(path: string, cwd: string): Promise<string> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    return await readFile(absolute, "utf8");
  } catch (cause) {
    const error = usage(`file could not be read: ${path}`, ["Rerun with a readable file path"]);
    error.cause = cause;
    throw error;
  }
}

interface TextFileFlag {
  flag: string;
  field: string;
  cwd: string;
  preserveExisting?: boolean;
}

export async function applyTextFileFlag(
  toolArgs: InputRecord,
  parsed: ParsedFlags,
  options: TextFileFlag,
): Promise<void> {
  const file = parsed[options.flag];
  if (file === undefined) return;
  if (options.preserveExisting && toolArgs[options.field] !== undefined) return;
  if (typeof file !== "string")
    throw usage(`--${options.flag} requires a path`, ["Rerun with a readable file path"]);
  toolArgs[options.field] = await readTextFlag(file, options.cwd);
}

function appendFlag(parts: string[], name: string, value: unknown): void {
  if (value === true) {
    parts.push(`--${name}`);
    return;
  }
  if (value === false) {
    parts.push(`--${name}=false`);
    return;
  }
  parts.push(`--${name}`, formatCommandArg(value));
}

function coerceArg(name: string, value: unknown): unknown {
  if (["limit", "estimate", "priority"].includes(name)) return parseFiniteNumber(name, value);
  if (TOOL_BOOLEAN_FLAGS.includes(name)) return value === true || value === "true";
  return value;
}
