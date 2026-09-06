import path from "node:path";
import { fileURLToPath } from "node:url";

export type CodeViewScheme = "ast" | "symbol" | "graph";

export interface CodeViewReference {
  readonly scheme: CodeViewScheme;
  readonly path: string;
  readonly selector?: readonly string[];
}

export function parseCodeViewReference(
  source: string,
  scheme: CodeViewScheme,
): CodeViewReference | undefined {
  const prefix = `${scheme}:`;

  if (!source.startsWith(prefix)) {
    return undefined;
  }

  const value = source.slice(prefix.length);
  const fragmentAt = value.indexOf("#");
  const encodedPath = fragmentAt === -1 ? value : value.slice(0, fragmentAt);

  if (encodedPath.length === 0) {
    throw new TypeError(`${scheme}: requires a file path.`);
  }

  const filePath = decodePart(encodedPath, `${scheme}: path`);
  const encodedSelector = fragmentAt === -1 ? undefined : value.slice(fragmentAt + 1);

  if (scheme === "ast") {
    if (encodedSelector !== undefined) {
      throw new TypeError("ast: accepts only a file path and does not accept a symbol selector.");
    }

    return { scheme, path: filePath };
  }

  if (scheme === "symbol" && encodedSelector === undefined) {
    throw new TypeError("symbol: requires #<symbol-selector> after the file path.");
  }

  if (encodedSelector === undefined) {
    return { scheme, path: filePath };
  }

  if (encodedSelector.length === 0) {
    throw new TypeError(`${scheme}: symbol selector must not be empty.`);
  }

  const selector = encodedSelector.split("/").map((segment) => {
    if (segment.length === 0) {
      throw new TypeError(`${scheme}: symbol selector contains an empty segment.`);
    }

    return decodePart(segment, `${scheme}: symbol selector`);
  });

  return { scheme, path: filePath, selector };
}

export function resolveCodeViewPath(filePath: string, cwd: string): string {
  if (filePath.startsWith("file://")) {
    return fileURLToPath(new URL(filePath));
  }

  return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
}

export function formatCodeViewReference(
  scheme: CodeViewScheme,
  filePath: string,
  selector?: readonly string[],
): string {
  const encodedPath = filePath.replaceAll("%", "%25").replaceAll("#", "%23");
  const fragment =
    selector === undefined
      ? ""
      : `#${selector.map((segment) => encodeURIComponent(segment)).join("/")}`;
  return `${scheme}:${encodedPath}${fragment}`;
}

export function formatSymbolSelector(selector: readonly string[]): string {
  return selector.map((segment) => encodeURIComponent(segment)).join("/");
}

function decodePart(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new TypeError(`${label} contains invalid percent encoding.`, { cause: error });
  }
}
