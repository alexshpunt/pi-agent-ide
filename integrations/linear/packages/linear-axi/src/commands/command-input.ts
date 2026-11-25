import { usage } from "#axi/args.ts";

/** Only flags declared as scalar text can be used as paths, identities, or other text arguments. */
export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Refuse missing or malformed CLI text before sending a request. */
export function requireText(value: unknown, message: string, help: string[]): string {
  if (typeof value !== "string" || !value) throw usage(message, help);
  return value;
}
