import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decode } from "@toon-format/toon-v4";
import { decodeAxiObject, decodeDocument, decodeIssue, runAxi } from "./axi.ts";
import { isDocumentId, parseDocumentUrl, parseIssueUrl, parsePageUrl } from "./urls.ts";
import type { LinearObjectPage, LinearObjectSearch, LinearTextSnapshot } from "./search.ts";
import { withLinearJson } from "./json-read.ts";

/** A paginated collection belongs to one verified Linear parent, not a workspace crawl. */
export interface LinearCollectionAddress {
  readonly workspace: string;
  readonly parentKind: "issue" | "project" | "document";
  readonly identifier: string;
  readonly parentSource: string;
  readonly collection: "comments" | "subtasks";
  readonly cursor?: string;
  readonly source: string;
}
interface Parent {
  readonly id: string;
  readonly uuid: string;
  readonly url: string;
}
interface Page {
  readonly rows: readonly Record<string, unknown>[];
  readonly cursor?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LINEAR_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function requiredText(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("LINEAR_INVALID_RESPONSE");
  return value;
}

/** Recognize only comments/subtasks fragments, leaving other field fragments to their owner. */
export function parseLinearCollectionAddress(source: string): LinearCollectionAddress | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "linear:" && url.hostname !== "linear.app") ||
    !["#comments", "#subtasks"].includes(url.hash)
  )
    return undefined;
  if (
    url.protocol === "https:" &&
    ["docs", "developers", "oauth", "login", "settings"].includes(url.pathname.split("/")[1] ?? "")
  )
    return undefined;
  const collection = url.hash.slice(1) as LinearCollectionAddress["collection"];
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (
    !["linear:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    [...url.searchParams.keys()].some((key) => key !== "cursor") ||
    url.searchParams.getAll("cursor").length > 1 ||
    (cursor !== undefined && (!cursor || cursor.length > 1024 || /[\r\n]/u.test(cursor)))
  )
    throw new Error("LINEAR_INVALID_URL");
  const parent = new URL(url);
  parent.hash = "";
  parent.search = "";
  let workspace: string;
  let parentKind: LinearCollectionAddress["parentKind"];
  let identifier: string;
  if (url.protocol === "linear:") {
    const match = /^\/(issue|project|document)\/([^/]+)\/?$/u.exec(url.pathname);
    if (!/^[A-Za-z0-9_-]+$/u.test(url.hostname) || !match) throw new Error("LINEAR_INVALID_URL");
    workspace = url.hostname;
    parentKind = match[1] as LinearCollectionAddress["parentKind"];
    identifier = parentKind === "issue" ? match[2].toUpperCase() : match[2].toLowerCase();
    if (
      parentKind === "issue" ? !/^[A-Z][A-Z0-9]*-\d+$/u.test(identifier) : !isDocumentId(identifier)
    )
      throw new Error("LINEAR_INVALID_URL");
    url.pathname = parent.pathname = `/${parentKind}/${identifier}`;
  } else {
    if (/^\/[^/]+\/issue\//u.test(parent.pathname)) {
      const issue = parseIssueUrl(parent.href);
      if (!issue) throw new Error("LINEAR_INVALID_URL");
      ({ workspace, identifier } = issue);
      identifier = identifier.toUpperCase();
      parentKind = "issue";
    } else if (/^\/[^/]+\/document\//u.test(parent.pathname)) {
      const document = parseDocumentUrl(parent.href);
      if (!document) throw new Error("LINEAR_INVALID_URL");
      ({ workspace, identifier } = document);
      parentKind = "document";
    } else {
      const project = parsePageUrl(parent.href);
      if (project?.kind !== "project") throw new Error("LINEAR_INVALID_URL");
      ({ workspace, identifier } = project);
      parentKind = "project";
    }
  }
  if (collection === "subtasks" && parentKind !== "issue") throw new Error("LINEAR_INVALID_URL");
  return {
    workspace,
    parentKind,
    identifier,
    collection,
    parentSource: parent.href,
    source: url.href,
    ...(cursor ? { cursor } : {}),
  };
}

/** Build a continuation without losing the collection fragment or its original parent. */
export function linearCollectionPage(address: LinearCollectionAddress, cursor?: string): string {
  const url = new URL(address.source);
  url.search = "";
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.href;
}

async function verifyParent(
  address: LinearCollectionAddress,
  cwd: string,
  signal: AbortSignal | undefined,
  run: typeof runAxi,
): Promise<Parent> {
  signal?.throwIfAborted();
  if (address.parentKind === "issue") {
    const issue = decodeIssue(
      await run(cwd, ["issues", "view", address.identifier, "--full"], signal),
      `https://linear.app/${address.workspace}/issue/${address.identifier}`,
    );
    if (!issue.uuid || !isDocumentId(issue.uuid)) throw new Error("LINEAR_IDENTITY_UNVERIFIED");
    return { id: issue.id, uuid: issue.uuid, url: issue.url };
  }
  if (address.parentKind === "document") {
    const document = decodeDocument(
      await run(cwd, ["documents", "view", address.identifier, "--full"], signal),
      address.parentSource,
    );
    return { id: document.id, uuid: document.id, url: document.url };
  }
  const row = object(
    decodeAxiObject(
      await run(cwd, ["projects", "view", address.identifier, "--full"], signal),
      "project",
      ["id", "uuid", "url"],
    ).project,
  );
  const uuid = isDocumentId(String(row.uuid)) ? String(row.uuid) : requiredText(row.id);
  const returned = parsePageUrl(requiredText(row.url));
  if (
    !isDocumentId(uuid) ||
    returned?.kind !== "project" ||
    returned.workspace !== address.workspace ||
    (isDocumentId(address.identifier)
      ? uuid.toLowerCase() !== address.identifier
      : returned.identifier !== address.identifier)
  )
    throw new Error("LINEAR_IDENTITY_MISMATCH");
  return { id: uuid, uuid, url: returned.source };
}

function page(
  value: unknown,
  key: "comments" | "issues",
  maximum: number,
  previous?: string,
): Page {
  const root = Array.isArray(value) ? { [key]: value } : object(value);
  const collection = root[key];
  const envelope =
    collection && typeof collection === "object" && !Array.isArray(collection)
      ? object(collection)
      : root;
  const rows = envelope[key];
  if (!Array.isArray(rows) || rows.length > maximum) throw new Error("LINEAR_INVALID_RESPONSE");
  const cursor =
    root.cursor ??
    envelope.cursor ??
    envelope.endCursor ??
    objectOrEmpty(envelope.pageInfo).endCursor;
  const hasMore = envelope.hasNextPage ?? objectOrEmpty(envelope.pageInfo).hasNextPage;
  if (hasMore !== undefined && typeof hasMore !== "boolean")
    throw new Error("LINEAR_INVALID_RESPONSE");
  const incomplete =
    hasMore === true || (typeof root.count === "string" && /more available/iu.test(root.count));
  if (
    cursor != null &&
    (typeof cursor !== "string" ||
      !cursor ||
      cursor.length > 1024 ||
      /[\r\n]/u.test(cursor) ||
      cursor === previous)
  )
    throw new Error("LINEAR_INVALID_RESPONSE");
  if (incomplete && !cursor) throw new Error("LINEAR_LOOKUP_INCOMPLETE");
  if (hasMore === false && cursor) throw new Error("LINEAR_INVALID_RESPONSE");
  return { rows: rows.map(object), ...(cursor ? { cursor } : {}) };
}
function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value == null ? {} : object(value);
}
function cliPage(
  output: string,
  key: "comments" | "issues",
  maximum: number,
  previous?: string,
): Page {
  try {
    const selected = output
      .split(/\n(?=\S)/u)
      .filter((chunk) => new RegExp(`^(?:${key}[\\[:]|count:|cursor:)`, "u").test(chunk))
      .join("\n");
    return page(decode(selected), key, maximum, previous);
  } catch (error) {
    if (error instanceof Error && error.message === "LINEAR_LOOKUP_INCOMPLETE") throw error;
    throw new Error("LINEAR_INVALID_RESPONSE", { cause: error });
  }
}
async function invokeComments(
  input: Record<string, unknown>,
  address: LinearCollectionAddress,
  cwd: string,
  signal: AbortSignal | undefined,
  run: typeof runAxi,
): Promise<unknown> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-linear-comments-"));
  try {
    const file = path.join(directory, "input.json");
    await writeFile(file, JSON.stringify(input), { mode: 0o600 });
    signal?.throwIfAborted();
    const row = object(
      decodeAxiObject(
        await run(
          cwd,
          [
            "resources",
            "invoke",
            "list_comments",
            "--workspace",
            address.workspace,
            "--input-file",
            file,
          ],
          signal,
        ),
        "invocation",
        ["workspace", "operation", "effect", "data", "error"],
      ).invocation,
    );
    if (row.workspace !== address.workspace || row.operation !== "list_comments")
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    if (row.effect !== "applied" || row.error)
      throw new Error(
        typeof row.error === "string" && /^LINEAR_[A-Z_]+$/u.test(row.error)
          ? row.error
          : "LINEAR_COLLECTION_READ_FAILED",
      );
    try {
      return JSON.parse(requiredText(row.data));
    } catch {
      throw new Error("LINEAR_INVALID_RESPONSE");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function commentsPage(
  address: LinearCollectionAddress,
  parent: Parent,
  cwd: string,
  signal: AbortSignal | undefined,
  run: typeof runAxi,
): Promise<Page> {
  if (address.parentKind === "issue") {
    return cliPage(
      await run(
        cwd,
        [
          "comments",
          "list",
          "--issue",
          parent.id,
          "--limit",
          "50",
          "--orderBy",
          "createdAt",
          "--full",
          ...(address.cursor ? ["--cursor", address.cursor] : []),
        ],
        signal,
      ),
      "comments",
      50,
      address.cursor,
    );
  }
  return page(
    await invokeComments(
      {
        [address.parentKind + "Id"]: parent.uuid,
        limit: 50,
        orderBy: "createdAt",
        ...(address.cursor ? { cursor: address.cursor } : {}),
      },
      address,
      cwd,
      signal,
      run,
    ),
    "comments",
    50,
    address.cursor,
  );
}
function commentLink(address: LinearCollectionAddress, parent: Parent, id: string): string {
  if (!isDocumentId(id)) throw new Error("LINEAR_INVALID_RESPONSE");
  return `linear://${address.workspace}/${address.parentKind}/${parent.id}/comment/${id.toLowerCase()}`;
}
function commentText(
  row: Record<string, unknown>,
  address: LinearCollectionAddress,
  parent: Parent,
): string {
  const id = requiredText(row.id);
  if (typeof row.body !== "string") throw new Error("LINEAR_INVALID_RESPONSE");
  const author =
    typeof row.user === "string"
      ? row.user
      : typeof objectOrEmpty(row.user).name === "string"
        ? String(objectOrEmpty(row.user).name)
        : undefined;
  const time = typeof row.createdAt === "string" ? row.createdAt : undefined;
  return [
    `### Comment ${id}`,
    `Read: <${commentLink(address, parent, id)}>`,
    `Editable body: <${commentLink(address, parent, id)}#body>`,
    `Actions: <linear://${address.workspace}/comment/${id}#actions>`,
    `Fields: <linear://${address.workspace}/comment/${id}#fields>`,
    `Delete: <linear://${address.workspace}/comment/${id}>`,
    ...(author ? [`Author: ${author.replace(/[\r\n]/gu, " ")}`] : []),
    ...(time ? [`Created: ${time.replace(/[\r\n]/gu, " ")}`] : []),
    "",
    row.body,
  ].join("\n");
}
async function childrenPage(
  address: LinearCollectionAddress,
  parent: Parent,
  cwd: string,
  signal: AbortSignal | undefined,
  run: typeof runAxi,
  maximum = 50,
  term?: string,
): Promise<Page> {
  const args = term
    ? ["search", "issues", "--query", term, "--include-comments"]
    : ["resources", "children"];
  const root = term ? "search" : "children";
  const response = object(
    decodeAxiObject(
      await run(
        cwd,
        [
          ...args,
          "--workspace",
          address.workspace,
          "--parent-id",
          parent.uuid,
          "--limit",
          String(maximum),
          ...(address.cursor ? ["--cursor", address.cursor] : []),
        ],
        signal,
      ),
      root,
      ["workspace", "parentId", "kind", "term", "items", "hasMore", "cursor", "totalCount"],
    )[root],
  );
  if (
    response.workspace !== address.workspace ||
    response.parentId !== parent.uuid ||
    (term && (response.kind !== "issues" || response.term !== term))
  )
    throw new Error("LINEAR_IDENTITY_MISMATCH");
  if (
    !Array.isArray(response.items) ||
    response.items.length > maximum ||
    typeof response.hasMore !== "boolean"
  )
    throw new Error("LINEAR_INVALID_RESPONSE");
  const cursor = response.hasMore ? requiredText(response.cursor) : undefined;
  if (cursor && (cursor === address.cursor || cursor.length > 1024 || /[\r\n]/u.test(cursor)))
    throw new Error("LINEAR_INVALID_RESPONSE");
  const result: Page = { rows: response.items.map(object), ...(cursor ? { cursor } : {}) };
  for (const row of result.rows) {
    const link = parseIssueUrl(requiredText(row.url));
    if (
      !link ||
      link.workspace !== address.workspace ||
      link.identifier !== row.id ||
      (!term && ![parent.uuid, parent.id].includes(String(row.parentId)))
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    requiredText(row.title);
  }
  return result;
}

/** Read one complete page with explicit next-page coverage; linked bodies remain lazy. */
export function createAxiCollectionReader(run: typeof runAxi = runAxi) {
  return async (source: string, cwd: string, signal?: AbortSignal): Promise<LinearTextSnapshot> => {
    const address = parseLinearCollectionAddress(source);
    if (!address) throw new Error("LINEAR_INVALID_URL");
    const parent = await verifyParent(address, cwd, signal, run);
    const result =
      address.collection === "comments"
        ? await commentsPage(address, parent, cwd, signal, run)
        : await childrenPage(address, parent, cwd, signal, run);
    const content = [
      `# ${address.collection === "comments" ? "Comments" : "Subtasks"} (${result.rows.length})`,
      `Parent: <${parent.url}>`,
      result.cursor ? "Coverage is incomplete; more results are available." : "End of results.",
      ...(result.cursor ? [`Next page: <${linearCollectionPage(address, result.cursor)}>`] : []),
      "",
      ...result.rows.map((row) =>
        address.collection === "comments"
          ? commentText(row, address, parent)
          : collectionItemText(row),
      ),
    ].join("\n\n");
    return withLinearJson(
      { source: address.source, content, complete: !result.cursor },
      { items: result.rows, hasMore: !!result.cursor, cursor: result.cursor ?? null },
      result.cursor
        ? `Coverage: this page only.\nNext page: ${linearCollectionPage(address, result.cursor)}`
        : "End of API results.",
    );
  };
}

/** Find one addressed comment, stopping on repeated cursors, missing data or the bounded page limit. */
export function createAxiCommentReader(run: typeof runAxi = runAxi) {
  return async (source: string, cwd: string, signal?: AbortSignal): Promise<LinearTextSnapshot> => {
    const url = new URL(source);
    const match = /^\/(issue|project|document)\/([^/]+)\/comment\/([^/]+)$/u.exec(url.pathname);
    if (
      url.protocol !== "linear:" ||
      !match ||
      !isDocumentId(match[3]) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error("LINEAR_INVALID_URL");
    const address = parseLinearCollectionAddress(
      `linear://${url.hostname}/${match[1]}/${match[2]}#comments`,
    );
    if (!address) throw new Error("LINEAR_INVALID_URL");
    // An issue's comment list is addressed by the same identifier the parent check verifies,
    // so the first page and the check are independent requests and run together. A parent
    // failure still takes precedence. Project and document lists need the verified UUID.
    let first: Promise<Page> | undefined;
    if (address.parentKind === "issue") {
      first = commentsPage(
        address,
        { id: address.identifier, uuid: "", url: "" },
        cwd,
        signal,
        run,
      );
      first.catch(() => {});
    }
    const parent = await verifyParent(address, cwd, signal, run);
    if (first && parent.id !== address.identifier) throw new Error("LINEAR_IDENTITY_MISMATCH");
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let index = 0; index < 20; index++) {
      const result =
        index === 0 && first
          ? await first
          : await commentsPage({ ...address, cursor }, parent, cwd, signal, run);
      const row = result.rows.find(
        (row) => typeof row.id === "string" && row.id.toLowerCase() === match[3].toLowerCase(),
      );
      if (row) {
        if (typeof row.body !== "string") throw new Error("LINEAR_INVALID_RESPONSE");
        return {
          source: commentLink(address, parent, match[3]),
          content: row.body,
          complete: true,
        };
      }
      if (!result.cursor) throw new Error("LINEAR_NOT_FOUND");
      if (seen.has(result.cursor)) throw new Error("LINEAR_INVALID_RESPONSE");
      cursor = result.cursor;
      seen.add(cursor);
    }
    throw new Error("LINEAR_LOOKUP_INCOMPLETE");
  };
}

/** Parent-scoped object lookup uses the backend's title/description query, never card text. */
export async function searchAxiSubtasks(
  request: LinearObjectSearch,
  cwd: string,
  run: typeof runAxi = runAxi,
  signal?: AbortSignal,
  cursor?: string,
): Promise<LinearObjectPage & { readonly cursor?: string }> {
  if (
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 50 ||
    !request.term.trim() ||
    request.term.length > 4096 ||
    (cursor !== undefined && (!cursor || cursor.length > 1024 || /[\r\n]/u.test(cursor)))
  )
    throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
  const url = new URL(request.scope);
  if (url.hash && url.hash !== "#subtasks") throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
  url.hash = "#subtasks";
  const address = parseLinearCollectionAddress(url.href);
  if (
    address?.parentKind !== "issue" ||
    request.kind !== "issues" ||
    address.workspace !== request.workspace
  )
    throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
  const parent = await verifyParent(address, cwd, signal, run);
  const result = await childrenPage(
    { ...address, cursor: cursor ?? address.cursor },
    parent,
    cwd,
    signal,
    run,
    request.limit,
    request.term,
  );
  return {
    kind: "issues",
    workspace: request.workspace,
    term: request.term,
    items: result.rows.map((row) => ({
      id: requiredText(row.id),
      title: requiredText(row.title),
      url: requiredText(row.url),
    })),
    complete: !result.cursor,
    notice:
      "Direct children only. Native full-text search including comments; totals and pagination are candidate-window coverage before parent filtering.",
    ...(result.cursor ? { cursor: result.cursor } : {}),
  };
}

function collectionItemText(row: Record<string, unknown>): string {
  const { id, title, url } = row;
  if (typeof id !== "string" || typeof title !== "string" || typeof url !== "string")
    throw new Error("LINEAR_INVALID_RESPONSE");
  return `- ${id}: ${title.replace(/[\r\n]/gu, " ")}: <${url}>`;
}
