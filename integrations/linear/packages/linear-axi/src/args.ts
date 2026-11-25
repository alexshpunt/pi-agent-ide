import type { FlagValue, ParsedFlags, ParseFlagOptions } from "./types.ts";

export function parseFlags(args: string[], options: ParseFlagOptions = {}): ParsedFlags {
  const parsed: ParsedFlags = { positionals: [] };
  const booleanFlags = new Set(options.boolean ?? []);
  const arrayFlags = new Set(options.array ?? []);

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }

    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (!name) {
      throw usage("empty flag name", ["Run `linear-axi --help`"]);
    }

    let value: Exclude<FlagValue, unknown[] | undefined>;
    if (booleanFlags.has(name)) {
      value = equals === -1 ? true : parseBoolean(arg.slice(equals + 1), name);
    } else if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else {
      index += 1;
      if (index >= args.length) {
        throw usage(`--${name} requires a value`, [
          `Run \`linear-axi ${options.example ?? "--help"}\``,
        ]);
      }
      value = args[index];
    }

    if (arrayFlags.has(name)) {
      const previous = parsed[name];
      if (previous !== undefined && !Array.isArray(previous) && typeof previous !== "string") {
        throw new TypeError("Flag values are not iterable");
      }
      parsed[name] = (
        typeof previous === "string" ? Array.from(previous) : (previous ?? [])
      ).concat(value);
    } else {
      parsed[name] = value;
    }
  }

  return parsed;
}

function parseBoolean(value: string, flagName: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw usage(`--${flagName} must be true or false`, ["Run `linear-axi --help`"]);
}

const ERROR_CODES: Record<string, string | undefined> = {
  usage: "VALIDATION_ERROR",
  not_found: "NOT_FOUND",
};

const FALLBACK_ERROR_MESSAGE = "The Linear operation failed.";
const ERROR_TYPE_MESSAGES: Record<string, string | undefined> = {
  VALIDATION_ERROR: "The command input or saved local configuration is invalid.",
  NOT_FOUND: "The requested Linear resource was not found.",
};

export class AxiError extends Error {
  kind: string;
  help: string[];
  exitCode: number;
  code: string;
  type: string;

  constructor(kind: string, message: string, help: string[] = []) {
    super(message);
    this.kind = kind;
    this.help = help;
    this.exitCode = kind === "usage" ? 2 : 1;
    this.code = ERROR_CODES[kind] ?? "OPERATION_ERROR";
    this.type = errorTypeMessage(this.code);
  }
}

export function usage(message: string, help: string[] = []) {
  return new AxiError("usage", message, help);
}

export function errorTypeMessage(code: string) {
  return ERROR_TYPE_MESSAGES[code] ?? FALLBACK_ERROR_MESSAGE;
}
