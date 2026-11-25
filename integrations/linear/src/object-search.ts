import { decodeAxiObject, runAxi } from "./axi.ts";
import type { LinearObjectPage, LinearObjectSearch, ObjectSearcher } from "./search.ts";
import { isDocumentId, parsePageUrl } from "./urls.ts";
import { searchAxiSubtasks } from "./collections.ts";

export const directoryKinds = [
  "teams",
  "users",
  "labels",
  "cycles",
  "statuses",
  "milestones",
  "releases",
  "views",
] as const;
const nativeKinds = ["issues", "projects", "documents"];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LINEAR_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("LINEAR_INVALID_RESPONSE");
  return value;
}
export interface SearchAddress {
  workspace: string;
  kind: string;
  term: string;
  scope: string;
  limit: number;
  cursor: string;
  source: string;
}
/** A continuation is itself a Read resource; its scope/query/limit stay part of its identity. */
export function parseSearchAddress(source: string): SearchAddress | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.protocol !== "linear:" || !url.pathname.startsWith("/search/")) return undefined;
  const kind = url.pathname.slice(8);
  const term = url.searchParams.get("q") ?? "";
  const scope = url.searchParams.get("scope") ?? "";
  const cursor = url.searchParams.get("cursor") ?? "";
  const limit = Number(url.searchParams.get("limit"));
  if (
    !/^[A-Za-z0-9_-]+$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    ![...nativeKinds, ...directoryKinds].includes(kind) ||
    !term ||
    term.length > 4096 ||
    !scope ||
    !cursor ||
    cursor.length > 1024 ||
    /[\r\n]/.test(cursor) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    [...url.searchParams.keys()].some((key) => !["q", "scope", "cursor", "limit"].includes(key)) ||
    [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
  )
    throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
  return { workspace: url.hostname, kind, term, scope, limit, cursor, source: url.href };
}
function nextAddress(request: LinearObjectSearch, cursor: string, scope: string): string {
  const url = new URL(`linear://${request.workspace}/search/${request.kind}`);
  url.searchParams.set("q", request.term);
  url.searchParams.set("scope", scope);
  url.searchParams.set("limit", String(request.limit));
  url.searchParams.set("cursor", cursor);
  return url.href;
}
/** Stable identity for directory objects that have no native URL exposed by the API. */
export function resourceAddress(
  workspace: string,
  kind: string,
  id: string,
  parent?: string,
  query?: string,
  cursor?: string,
): string {
  if (!isDocumentId(id)) throw new Error("LINEAR_INVALID_RESPONSE");
  const url = new URL(`linear://${workspace}/resource/${kind}/${id}`);
  if (parent) url.searchParams.set("parent", parent);
  if (query) url.searchParams.set("q", query);
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.href;
}
export interface DirectoryAddress {
  workspace: string;
  kind: string;
  id: string;
  parent?: string;
  query?: string;
  cursor?: string;
  source: string;
}
/** Parse only explicit supported resource kinds, never arbitrary backend tool names. */
export function parseResourceAddress(source: string): DirectoryAddress | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.protocol !== "linear:" || !url.pathname.startsWith("/resource/")) return undefined;
  const match = /^\/resource\/([a-z]+)\/([^/]+)$/.exec(url.pathname);
  const parent = url.searchParams.get("parent") ?? undefined;
  const query = url.searchParams.get("q") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (
    !match ||
    ![...directoryKinds, "attachments"].includes(match[1]) ||
    !isDocumentId(match[2]) ||
    (parent && !isDocumentId(parent)) ||
    !/^[A-Za-z0-9_-]+$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !["parent", "q", "cursor"].includes(key)) ||
    [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1) ||
    (query !== undefined && (!query || query.length > 4096)) ||
    (cursor !== undefined && (!cursor || cursor.length > 1024 || /[\r\n]/u.test(cursor)))
  )
    throw new Error("LINEAR_INVALID_URL");
  return {
    workspace: url.hostname,
    kind: match[1],
    id: match[2],
    ...(parent ? { parent } : {}),
    ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {}),
    source: url.href,
  };
}
/** Native object search plus documented directory lookups, with scope and page verification. */
export function createAxiObjectSearcher(run: typeof runAxi = runAxi): ObjectSearcher {
  return async (input, cwd, signal) => {
    const continuation = parseSearchAddress(input.scope);
    if (
      continuation &&
      (continuation.workspace !== input.workspace ||
        continuation.kind !== input.kind ||
        continuation.term !== input.term)
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    const request = continuation
      ? { ...input, scope: continuation.scope, limit: continuation.limit }
      : input;
    const url = new URL(request.scope);
    const milestone = url.searchParams.get("milestone");
    if (milestone !== null) {
      if (
        request.kind !== "issues" ||
        url.searchParams.getAll("milestone").length !== 1 ||
        !milestone.trim() ||
        milestone.length > 4096 ||
        [...url.searchParams.keys()].some((key) => key !== "milestone")
      )
        throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
      url.searchParams.delete("milestone");
    }
    if (
      (url.protocol === "linear:" && url.pathname.startsWith("/issue/")) ||
      (url.hostname === "linear.app" && /^\/[^/]+\/issue\//u.test(url.pathname))
    ) {
      if (milestone !== null) throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
      const { cursor, ...result } = await searchAxiSubtasks(
        request,
        cwd,
        run,
        signal,
        continuation?.cursor,
      );
      return {
        ...result,
        ...(cursor ? { next: nextAddress(request, cursor, request.scope) } : {}),
      };
    }
    if (
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      (url.protocol === "linear:" && url.search)
    )
      throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
    const global =
      url.protocol === "linear:" &&
      url.hostname === request.workspace &&
      (url.pathname === "" || url.pathname === "/");
    const stableProject =
      url.protocol === "linear:" ? /^\/project\/([^/]+)\/?$/u.exec(url.pathname) : null;
    const page = global
      ? undefined
      : stableProject && isDocumentId(stableProject[1])
        ? {
            kind: "project" as const,
            workspace: url.hostname,
            identifier: stableProject[1].toLowerCase(),
            source: url.href,
          }
        : parsePageUrl(url.href);
    if (!global && (!page || page.workspace !== request.workspace))
      throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
    let teamId: string | undefined;
    let projectId: string | undefined;
    if (page) {
      const kind = page.kind === "project" ? "project" : "team";
      const detail = object(
        decodeAxiObject(
          await run(
            cwd,
            ["resources", "scope", kind, page.identifier, "--workspace", request.workspace],
            signal,
          ),
          kind,
          ["id", "uuid", "url", "key"],
        )[kind],
      );
      const id = isDocumentId(String(detail.id)) ? String(detail.id) : String(detail.uuid);
      if (!isDocumentId(id)) throw new Error("LINEAR_INVALID_RESPONSE");
      if (kind === "project") {
        const returned = parsePageUrl(text(detail.url));
        if (
          !returned ||
          returned.kind !== "project" ||
          returned.workspace !== request.workspace ||
          (returned.identifier !== page.identifier && id !== page.identifier)
        )
          throw new Error("LINEAR_IDENTITY_MISMATCH");
        projectId = id;
      } else {
        if (text(detail.key).toLowerCase() !== page.identifier.toLowerCase())
          throw new Error("LINEAR_IDENTITY_MISMATCH");
        teamId = id;
      }
    }
    let milestoneReference = milestone;
    if (milestone !== null) {
      if (!projectId) throw new Error("LINEAR_PARENT_SCOPE_REQUIRED");
      if (milestone.includes("://")) {
        const resource = parseResourceAddress(milestone);
        if (
          !resource ||
          resource.kind !== "milestones" ||
          resource.workspace !== request.workspace ||
          resource.parent?.toLowerCase() !== projectId.toLowerCase() ||
          resource.query ||
          resource.cursor
        )
          throw new Error("LINEAR_IDENTITY_MISMATCH");
        milestoneReference = resource.id;
      }
    }
    const native = nativeKinds.includes(request.kind);
    if (!native && !(directoryKinds as readonly string[]).includes(request.kind))
      throw new Error("LINEAR_SEARCH_KIND_UNSUPPORTED");
    if (
      !native &&
      ((projectId && request.kind !== "milestones") ||
        (request.kind === "milestones" && !projectId) ||
        (["cycles", "statuses"].includes(request.kind) && !teamId))
    )
      throw new Error("LINEAR_PARENT_SCOPE_REQUIRED");
    if (!native && teamId && ["teams", "releases"].includes(request.kind))
      throw new Error("LINEAR_API_SCOPE_UNSUPPORTED");
    const directoryScope = teamId ?? projectId;
    const args = native
      ? [
          "search",
          request.kind,
          "--query",
          request.term,
          "--workspace",
          request.workspace,
          "--limit",
          String(request.limit),
          "--include-comments",
          ...(teamId ? ["--team-id", teamId] : []),
          ...(projectId ? ["--project-id", projectId] : []),
          ...(milestoneReference !== null ? ["--milestone", milestoneReference] : []),
        ]
      : [
          "resources",
          "list",
          request.kind,
          "--workspace",
          request.workspace,
          "--query",
          request.term,
          "--limit",
          String(request.limit),
          ...(directoryScope ? ["--scope", directoryScope] : []),
        ];
    if (continuation) args.push("--cursor", continuation.cursor);
    const root = native ? "search" : "directory";
    const data = object(
      decodeAxiObject(await run(cwd, args, signal), root, [
        "kind",
        "workspace",
        "term",
        "items",
        "hasMore",
        "cursor",
        "totalCount",
        "postFiltered",
        "milestoneId",
        "coverage",
      ])[root],
    );
    if (
      data.workspace !== request.workspace ||
      data.kind !== request.kind ||
      (native && data.term !== request.term)
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    if (
      !Array.isArray(data.items) ||
      data.items.length > request.limit ||
      typeof data.hasMore !== "boolean"
    )
      throw new Error("LINEAR_INVALID_RESPONSE");
    let nextScope = request.scope;
    if (milestone !== null) {
      if (
        typeof data.milestoneId !== "string" ||
        !isDocumentId(data.milestoneId) ||
        (milestoneReference !== null &&
          isDocumentId(milestoneReference) &&
          data.milestoneId.toLowerCase() !== milestoneReference.toLowerCase())
      )
        throw new Error("LINEAR_IDENTITY_MISMATCH");
      const pinned = new URL(request.scope);
      pinned.searchParams.set("milestone", data.milestoneId.toLowerCase());
      nextScope = pinned.href;
    }
    const items = data.items.map((value) => {
      const row = object(value);
      const id = text(row.id);
      const title = text(row.title);
      const address = native
        ? text(row.url)
        : resourceAddress(
            request.workspace,
            request.kind,
            id,
            teamId ?? projectId,
            ["labels", "views"].includes(request.kind) ? request.term : undefined,
            ["labels", "views"].includes(request.kind) ? continuation?.cursor : undefined,
          );
      if (native) {
        const link = new URL(address);
        if (
          link.protocol !== "https:" ||
          link.hostname !== "linear.app" ||
          link.username ||
          link.password ||
          link.port ||
          !link.pathname.startsWith(
            `/${request.workspace}/${request.kind === "issues" ? "issue" : request.kind === "projects" ? "project" : "document"}/`,
          )
        )
          throw new Error("LINEAR_IDENTITY_MISMATCH");
      }
      return { id, title, url: address };
    });
    let next: string | undefined;
    if (data.cursor !== undefined) {
      const cursor = text(data.cursor);
      if (cursor.length > 1024 || /[\r\n]/.test(cursor) || cursor === continuation?.cursor)
        throw new Error("LINEAR_INVALID_RESPONSE");
      next = nextAddress(request, cursor, nextScope);
    }
    if (native && data.hasMore && !next) throw new Error("LINEAR_INVALID_RESPONSE");
    return {
      kind: request.kind,
      workspace: request.workspace,
      term: request.term,
      items,
      complete: !data.hasMore,
      ...(next ? { next } : {}),
      notice: native
        ? `Native GraphQL search; comments included. Native total: ${typeof data.totalCount === "number" ? data.totalCount : "unreported"}${data.postFiltered ? " (before scope post-filtering)" : ""}.`
        : text(data.coverage),
    };
  };
}
export const searchAxiObjects = createAxiObjectSearcher();
/** Render object identities without fetching their bodies. */
export function objectPageText(page: LinearObjectPage): string {
  return [
    `Linear ${page.kind}: ${page.term}`,
    `Workspace: ${page.workspace}`,
    `Returned: ${page.items.length}`,
    page.complete ? "End of results." : "Coverage is incomplete; do not conclude absence.",
    ...(page.next ? [`Next page: <${page.next}>`] : []),
    ...(page.notice ? [page.notice] : []),
    "",
    ...page.items.map(
      (item) => `- ${item.id}: ${item.title.replace(/[\r\n]+/g, " ")}: <${item.url}>`,
    ),
  ].join("\n");
}
