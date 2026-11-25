import { asArrayOfUnknown, asRecord, type InputRecord } from "#axi/types.ts";

/** Full-text operations exposed by Linear's official GraphQL schema. */
export type NativeSearchKind = "issues" | "projects" | "documents";

/** A bounded native query. Team/project IDs are hard scope constraints, not ranking boosts. */
export interface NativeSearchInput {
  kind: NativeSearchKind;
  term: string;
  workspace: string;
  limit?: number;
  cursor?: string;
  includeComments?: boolean;
  includeArchived?: boolean;
  teamId?: string;
  projectId?: string;
  /** Canonical parent UUID. Includes direct children only, never descendants. */
  parentId?: string;
  /** Verified project milestone UUID; requires the selected project. */
  milestoneId?: string;
  signal?: AbortSignal;
}
/** Stable native identities plus server pagination. Totals are server totals before post-filtering. */
export interface NativeSearchPage {
  kind: NativeSearchKind;
  term: string;
  workspace: string;
  items: Array<{ id: string; title: string; url: string }>;
  hasMore: boolean;
  cursor?: string;
  totalCount: number;
  postFiltered: boolean;
  parentId?: string;
  milestoneId?: string;
}

const FIELDS = {
  issues:
    "id identifier title url team { id } project { id } parent { id } projectMilestone { id }",
  projects: "id name url",
  documents: "id title url project { id } team { id } issue { team { id } project { id } }",
} satisfies Record<NativeSearchKind, string>;

/** Build a fixed GraphQL query; user text is carried only in variables. */
export function nativeSearchQuery(input: NativeSearchInput): {
  query: string;
  variables: Record<string, unknown>;
} {
  if (
    !Object.hasOwn(FIELDS, input.kind) ||
    !input.term.trim() ||
    (input.milestoneId !== undefined &&
      (input.kind !== "issues" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(input.milestoneId) ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(input.projectId ?? ""))) ||
    !/^[A-Za-z0-9_-]+$/u.test(input.workspace) ||
    (input.parentId !== undefined &&
      (input.kind !== "issues" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.parentId)))
  )
    throw new Error("LINEAR_INVALID_QUERY");
  const first = input.limit ?? 50;
  if (
    !Number.isInteger(first) ||
    first < 1 ||
    first > 50 ||
    (input.cursor !== undefined &&
      (!input.cursor || input.cursor.length > 1024 || /[\r\n]/u.test(input.cursor)))
  )
    throw new Error("LINEAR_INVALID_QUERY");
  const operation =
    input.kind === "issues"
      ? "searchIssues"
      : input.kind === "projects"
        ? "searchProjects"
        : "searchDocuments";
  const filter = {
    ...(input.teamId ? { team: { id: { eq: input.teamId } } } : {}),
    ...(input.projectId ? { project: { id: { eq: input.projectId } } } : {}),
    ...(input.milestoneId
      ? { projectMilestone: { id: { eq: input.milestoneId.toLowerCase() } } }
      : {}),
    ...(input.parentId ? { parent: { id: { eq: input.parentId.toLowerCase() } } } : {}),
  };
  const hardFilter = input.kind === "issues" && Object.keys(filter).length > 0;
  return {
    query: `query NativeSearch($term: String!, $first: Int!, $after: String, $includeComments: Boolean!, $includeArchived: Boolean!${hardFilter ? ", $filter: IssueFilter" : ""}) {
  organization { urlKey }
  results: ${operation}(term: $term, first: $first, after: $after, includeComments: $includeComments, includeArchived: $includeArchived${hardFilter ? ", filter: $filter" : ""}) {
    nodes { ${FIELDS[input.kind]}${input.kind === "projects" && input.teamId ? " teams { nodes { id } }" : ""} }
    pageInfo { hasNextPage endCursor }
    totalCount
  }${
    hardFilter
      ? `
  candidates: searchIssues(term: $term, first: $first, after: $after, includeComments: $includeComments, includeArchived: $includeArchived) {
    nodes { id }
    pageInfo { hasNextPage endCursor }
    totalCount
  }`
      : ""
  }
}`,
    variables: {
      term: input.term,
      first,
      after: input.cursor ?? null,
      includeComments: input.includeComments ?? false,
      includeArchived: input.includeArchived ?? false,
      ...(hardFilter ? { filter } : {}),
    },
  };
}

function record(value: unknown): InputRecord {
  const result = asRecord(value);
  if (!result) throw new Error("LINEAR_INVALID_RESPONSE");
  return result;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("LINEAR_INVALID_RESPONSE");
  return value;
}
function scoped(node: InputRecord, input: NativeSearchInput): boolean {
  const issue = asRecord(node.issue);
  const projectId = asRecord(node.project)?.id ?? asRecord(issue?.project)?.id;
  const teamIds =
    input.kind === "projects"
      ? asArrayOfUnknown(asRecord(node.teams)?.nodes)?.map((item) => asRecord(item)?.id)
      : [asRecord(node.team)?.id ?? asRecord(issue?.team)?.id];
  const milestoneId = asRecord(node.projectMilestone)?.id;
  const parentId = asRecord(node.parent)?.id;
  return (
    (!input.projectId ||
      (input.kind === "projects" ? node.id === input.projectId : projectId === input.projectId)) &&
    (!input.teamId || teamIds?.includes(input.teamId) === true) &&
    (!input.milestoneId ||
      (typeof milestoneId === "string" &&
        milestoneId.toLowerCase() === input.milestoneId.toLowerCase())) &&
    (!input.parentId ||
      (typeof parentId === "string" && parentId.toLowerCase() === input.parentId.toLowerCase()))
  );
}

/** Refuse mismatched/malformed identities; preserve cursors even when a scope removes every row. */
export function nativeSearchPage(data: unknown, input: NativeSearchInput): NativeSearchPage {
  const root = record(data);
  const workspace = text(record(root.organization).urlKey);
  if (workspace !== input.workspace) throw new Error("LINEAR_IDENTITY_MISMATCH");
  const results = record(root.results);
  const info = record(results.pageInfo);
  const nodes = asArrayOfUnknown(results.nodes);
  if (
    !nodes ||
    nodes.length > (input.limit ?? 50) ||
    typeof info.hasNextPage !== "boolean" ||
    typeof results.totalCount !== "number" ||
    !Number.isFinite(results.totalCount) ||
    results.totalCount < 0
  )
    throw new Error("LINEAR_INVALID_RESPONSE");
  const filteredIssues =
    input.kind === "issues" && !!(input.parentId || input.teamId || input.projectId);
  let cursor = info.endCursor;
  const useCandidateCursor =
    !!input.parentId ||
    (filteredIssues && info.hasNextPage && cursor == null && nodes.length === 0);
  if (
    info.hasNextPage &&
    !useCandidateCursor &&
    (typeof cursor !== "string" ||
      !cursor ||
      cursor === input.cursor ||
      cursor.length > 1024 ||
      /[\r\n]/u.test(cursor))
  )
    throw new Error("LINEAR_INVALID_RESPONSE");
  const postFiltered = !!(input.parentId || input.teamId || input.projectId);
  const items: NativeSearchPage["items"] = [];
  for (const value of nodes) {
    const node = record(value);
    const id = input.kind === "issues" ? text(node.identifier) : text(node.id);
    const title = text(input.kind === "projects" ? node.name : node.title);
    let url: URL;
    try {
      url = new URL(text(node.url));
    } catch {
      throw new Error("LINEAR_INVALID_RESPONSE");
    }
    const kind =
      input.kind === "issues" ? "issue" : input.kind === "projects" ? "project" : "document";
    if (
      url.protocol !== "https:" ||
      url.hostname !== "linear.app" ||
      url.username ||
      url.password ||
      url.port ||
      !url.pathname.startsWith(`/${workspace}/${kind}/`)
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    if (input.kind === "issues" && url.pathname.split("/")[3] !== id)
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    const withinScope = scoped(node, input);
    if (!withinScope && (input.kind === "issues" || !postFiltered))
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    if (withinScope) items.push({ id, title, url: url.href });
  }
  if (useCandidateCursor) {
    // Parent windows need a verified candidate cursor. Other issue scopes use this only
    // for empty pages without a cursor; their matching-page order can differ from candidates.
    const candidates = record(root.candidates);
    const candidateInfo = record(candidates.pageInfo);
    const candidateNodes = asArrayOfUnknown(candidates.nodes);
    if (
      !candidateNodes ||
      candidateNodes.length > (input.limit ?? 50) ||
      candidateInfo.hasNextPage !== info.hasNextPage ||
      candidates.totalCount !== results.totalCount
    )
      throw new Error("LINEAR_INVALID_RESPONSE");
    const ids = new Set(candidateNodes.map((value) => text(record(value).id)));
    if (
      ids.size !== candidateNodes.length ||
      nodes.some((value) => !ids.has(text(record(value).id)))
    )
      throw new Error("LINEAR_INVALID_RESPONSE");
    cursor = candidateInfo.endCursor;
    if (
      info.hasNextPage &&
      (typeof cursor !== "string" ||
        !cursor ||
        cursor === input.cursor ||
        cursor.length > 1024 ||
        /[\r\n]/u.test(cursor))
    )
      throw new Error("LINEAR_INVALID_RESPONSE");
  }
  return {
    kind: input.kind,
    term: input.term,
    workspace,
    items,
    hasMore: info.hasNextPage,
    ...(info.hasNextPage && typeof cursor === "string" ? { cursor } : {}),
    totalCount: results.totalCount,
    postFiltered,
    ...(input.parentId ? { parentId: input.parentId.toLowerCase() } : {}),
    ...(input.milestoneId ? { milestoneId: input.milestoneId.toLowerCase() } : {}),
  };
}
