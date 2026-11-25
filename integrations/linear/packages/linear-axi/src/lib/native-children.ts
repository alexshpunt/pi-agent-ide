import { asArrayOfUnknown, asRecord, type InputRecord } from "#axi/types.ts";

/** A bounded, explicit direct-child collection, independent of full-text search. */
export interface NativeChildrenInput {
  workspace: string;
  parentId: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}
export interface NativeChildrenPage {
  workspace: string;
  parentId: string;
  items: Array<{ id: string; uuid: string; title: string; url: string; parentId: string }>;
  hasMore: boolean;
  cursor?: string;
}
export function nativeChildrenQuery(input: NativeChildrenInput) {
  const first = input.limit ?? 50;
  if (
    !/^[A-Za-z0-9_-]+$/u.test(input.workspace) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.parentId) ||
    !Number.isInteger(first) ||
    first < 1 ||
    first > 50 ||
    (input.cursor !== undefined &&
      (!input.cursor || input.cursor.length > 1024 || /[\r\n]/u.test(input.cursor)))
  )
    throw new Error("LINEAR_INVALID_QUERY");
  return {
    query: `query NativeChildren($first:Int!, $after:String, $filter:IssueFilter!, $parentId:String!) {
    organization { urlKey }
    parent: issue(id:$parentId) { id url }
    children: issues(first:$first,after:$after,filter:$filter) {
      nodes { id identifier title url parent { id } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
    variables: {
      first,
      after: input.cursor ?? null,
      parentId: input.parentId.toLowerCase(),
      filter: { parent: { id: { eq: input.parentId.toLowerCase() } } },
    },
  };
}
function record(value: unknown): InputRecord {
  const result = asRecord(value);
  if (!result) throw new Error("LINEAR_INVALID_RESPONSE");
  return result;
}
export function nativeChildrenPage(data: unknown, input: NativeChildrenInput): NativeChildrenPage {
  const root = record(data);
  if (record(root.organization).urlKey !== input.workspace)
    throw new Error("LINEAR_IDENTITY_MISMATCH");
  const parent = record(root.parent);
  if (
    parent.id !== input.parentId.toLowerCase() ||
    typeof parent.url !== "string" ||
    !parent.url.startsWith(`https://linear.app/${input.workspace}/issue/`)
  )
    throw new Error("LINEAR_IDENTITY_MISMATCH");
  const page = record(root.children),
    info = record(page.pageInfo);
  const nodes = asArrayOfUnknown(page.nodes);
  if (!nodes || nodes.length > (input.limit ?? 50) || typeof info.hasNextPage !== "boolean")
    throw new Error("LINEAR_INVALID_RESPONSE");
  const items = nodes.map((value) => {
    const { id, identifier, title, url: address, parent: issueParent } = record(value);
    const parentId = record(issueParent).id;
    if (typeof parentId !== "string" || parentId.toLowerCase() !== input.parentId.toLowerCase())
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    if (
      typeof id !== "string" ||
      !id ||
      typeof identifier !== "string" ||
      !identifier ||
      typeof title !== "string" ||
      !title ||
      typeof address !== "string" ||
      !address
    )
      throw new Error("LINEAR_INVALID_RESPONSE");
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new Error("LINEAR_INVALID_RESPONSE");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "linear.app" ||
      url.username ||
      url.password ||
      url.port ||
      !url.pathname.startsWith(`/${input.workspace}/issue/${identifier}/`)
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    return {
      id: identifier,
      uuid: id,
      title,
      url: url.href,
      parentId,
    };
  });
  const cursor = info.endCursor;
  if (
    info.hasNextPage &&
    (typeof cursor !== "string" ||
      !cursor ||
      cursor === input.cursor ||
      cursor.length > 1024 ||
      /[\r\n]/u.test(cursor))
  )
    throw new Error("LINEAR_INVALID_RESPONSE");
  return {
    workspace: input.workspace,
    parentId: input.parentId.toLowerCase(),
    items,
    hasMore: info.hasNextPage,
    ...(info.hasNextPage && typeof cursor === "string" ? { cursor } : {}),
  };
}
