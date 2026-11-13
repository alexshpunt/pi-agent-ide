import path from "node:path";

import { NULL_FIELD } from "./null-fields.ts";

const resultReference =
  /^(?:RESULT#|SEARCH#|<system-result\b)|^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u;

/** Whether a `path` list item is an issued Read/Search/edit result rather than a plain path. */
export function isResultReference(value: unknown): boolean {
  return typeof value !== "string" || resultReference.test(value);
}

/**
 * The paths of a `path` list that holds only plain file and directory paths, local or `ssh://`.
 * Returns undefined for a list of results, which a result scope resolves instead. A list that
 * mixes both kinds, or names another kind of source, is rejected with the forms it accepts.
 */
export function plainPathList(list: readonly unknown[]): readonly string[] | undefined {
  const plain = list.filter((item): item is string => !isResultReference(item));
  if (plain.length === 0) return undefined;
  if (plain.length < list.length)
    throw new Error(
      "A path list holds either file and directory paths or Read/Search/edit results and their UUIDs, not both. Search them in separate calls.",
    );
  for (const item of plain) {
    if (item.trim().length === 0) throw new Error("A path in a path list must not be empty.");
    // A one-letter scheme is a Windows drive, such as C:/src.
    if (/^[a-z][a-z\d+.-]+:/iu.test(item) && !item.startsWith("ssh://"))
      throw new Error(
        `A path list takes local or ssh:// file and directory paths. Search ${item} in a separate call.`,
      );
  }
  return plain;
}

/** The listed paths without repeats, each compared as an absolute path or URL. */
export function uniquePaths(paths: readonly string[], cwd: string): readonly string[] {
  const seen = new Set<string>();
  return paths.filter((item) => {
    const key = absoluteSource(item, cwd);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The machine a listed path is on: `local`, or the `ssh://` target that owns it. */
export function pathMachine(item: string, cwd: string): string {
  const source = absoluteSource(item, cwd);
  if (!source.includes("://")) return "local";
  const url = new URL(source);
  return `${url.protocol}//${url.host}`;
}

/** A short label of a `path` argument for tool call headers. */
export function describePathArgument(value: unknown): string {
  if (typeof value === "string") return value === NULL_FIELD ? "null" : value;
  if (Array.isArray(value) && value.length > 0 && !value.some(isResultReference))
    return (value as string[]).join(", ");
  return "result scope";
}

function absoluteSource(item: string, cwd: string): string {
  if (item.includes("://")) return item.replace(/\/+$/u, "");
  if (cwd.includes("://"))
    return new URL(item, cwd.endsWith("/") ? cwd : `${cwd}/`).href.replace(/\/+$/u, "");
  return path.resolve(cwd, item);
}
