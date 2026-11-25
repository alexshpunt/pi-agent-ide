import { isDocumentId } from "./urls.ts";

interface TextLocation {
  readonly workspace: string;
  readonly identifier: string;
  readonly source: string;
}

/** A payload-only text resource or an explicit creation target. */
export type LinearTextAddress = TextLocation &
  (
    | { readonly kind: "document-content" | "issue-description" | "project-description" }
    | {
        readonly kind: "create-document";
        readonly parentKind: "issue" | "project";
        readonly title: string;
      }
    | { readonly kind: "create-comment" }
  );

/** Recognize explicit Linear text addresses without claiming cards or other providers. */
export function parseTextAddress(source: string): LinearTextAddress | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    if (/^linear:/iu.test(source)) throw new Error("LINEAR_INVALID_URL");
    return undefined;
  }
  if (url.protocol !== "linear:") return undefined;
  const match =
    /^\/(document|issue|project)\/([^/]+)\/(content|description|documents\/new|comments\/new)\/?$/u.exec(
      url.pathname,
    );
  if (!match) return undefined;
  if (
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !/^[A-Za-z0-9_-]+$/u.test(url.hostname)
  ) {
    throw new Error("LINEAR_INVALID_URL");
  }
  const [, entity, id, operation] = match;
  const identifier = entity === "issue" ? id.toUpperCase() : id.toLowerCase();
  if (entity === "issue" ? !/^[A-Z][A-Z0-9]*-\d+$/u.test(identifier) : !isDocumentId(identifier)) {
    throw new Error("LINEAR_INVALID_URL");
  }
  url.pathname = `/${entity}/${identifier}/${operation}`;
  const location = { workspace: url.hostname, identifier, source: url.href };
  if (operation === "documents/new" && (entity === "issue" || entity === "project")) {
    const title = url.searchParams.get("title");
    if (
      url.searchParams.size !== 1 ||
      !title?.trim() ||
      title.length > 1000 ||
      /[\u0000-\u001f\u007f]/u.test(title)
    ) {
      throw new Error("LINEAR_INVALID_URL");
    }
    return { ...location, kind: "create-document", parentKind: entity, title };
  }
  if (url.search) throw new Error("LINEAR_INVALID_URL");
  if (entity === "issue" && operation === "comments/new")
    return { ...location, kind: "create-comment" };
  if (entity === "document" && operation === "content")
    return { ...location, kind: "document-content" };
  if (entity === "issue" && operation === "description")
    return { ...location, kind: "issue-description" };
  if (entity === "project" && operation === "description")
    return { ...location, kind: "project-description" };
  throw new Error("LINEAR_INVALID_URL");
}
