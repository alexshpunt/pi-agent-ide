import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ResourceError } from "pi-agent-ide/api/resource";
import { GithubApiError, type GithubClient } from "./client.ts";
import { githubScalarText } from "./api.ts";
import { githubResourceError } from "./resource-error.ts";
import { githubSource, parseGithubAddress, type GithubAddress } from "./address.ts";
import type { GithubApproval, GithubReceipt, GithubSnapshot } from "./backend.ts";
import type { GithubObjectPage, GithubObjectSearch } from "./search.ts";

type RecordValue = Record<string, unknown>;
const json = (value: unknown) => JSON.stringify(value, null, 2);
const revision = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
const opaque = Type.String({ minLength: 1, maxLength: 2048, pattern: "^[A-Za-z0-9_.=-]+$" });
const body = Type.String({ maxLength: 2 * 1024 * 1024 });
const title = Type.String({ minLength: 1, maxLength: 1024 });
const discussionSchema = Type.Object(
  { title: Type.Optional(title), body: Type.Optional(body), categoryId: Type.Optional(opaque) },
  { additionalProperties: false, minProperties: 1 },
);
const commentSchema = Type.Object({ body }, { additionalProperties: false });
const createDiscussionSchema = Type.Object(
  { categoryId: opaque, title, body },
  { additionalProperties: false },
);
const createCommentSchema = Type.Object(
  { body, replyToId: Type.Optional(opaque) },
  { additionalProperties: false },
);
const emptySchema = Type.Object({}, { additionalProperties: false });
const threadSchema = Type.Object({ resolved: Type.Boolean() }, { additionalProperties: false });
const repositoryFields = "id nameWithOwner";
const discussionIdentity = `__typename id number title url updatedAt repository{${repositoryFields}}`;
const discussionFields = `${discussionIdentity} body author{__typename login} category{id}`;
const commentIdentity = `__typename id url updatedAt discussion{ id number repository{${repositoryFields}} }`;
const commentFields = `${commentIdentity} body author{__typename login}`;
const threadFields = `__typename id isResolved isOutdated path line viewerCanResolve viewerCanUnresolve repository{${repositoryFields}} pullRequest{number}`;
const pageFields = "pageInfo{hasNextPage endCursor}";

function fail(
  code: string,
  address: GithubAddress,
  effect: "not-applied" | "unknown" = "not-applied",
): never {
  throw new ResourceError(code, address.source, effect);
}
function record(value: unknown, address: GithubAddress): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("GH_INVALID_RESPONSE", address);
  return value as RecordValue;
}
function id(value: unknown, address: GithubAddress): string {
  if (typeof value !== "string" || !Value.Check(opaque, value))
    fail("GH_INVALID_RESPONSE", address);
  return value;
}
function number(value: unknown, address: GithubAddress): number {
  const result = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 1)
    fail("GH_INVALID_RESPONSE", address);
  return result;
}
function checkRepository(value: unknown, address: GithubAddress): RecordValue {
  const result = record(value, address);
  if (
    typeof result.nameWithOwner !== "string" ||
    result.nameWithOwner.toLowerCase() !== `${address.owner}/${address.repo}`.toLowerCase()
  )
    fail("GH_IDENTITY_MISMATCH", address);
  return result;
}
function checkUrl(value: unknown, address: GithubAddress, discussionNumber: number): string {
  if (typeof value !== "string") fail("GH_INVALID_RESPONSE", address);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("GH_INVALID_RESPONSE", address);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname.toLowerCase() !==
      `/${address.owner}/${address.repo}/discussions/${discussionNumber}`.toLowerCase()
  )
    fail("GH_IDENTITY_MISMATCH", address);
  return value;
}
function checkDiscussion(
  value: unknown,
  address: GithubAddress,
  expectedNumber?: number,
): RecordValue {
  const result = record(value, address);
  if (result.__typename !== "Discussion") fail("GH_IDENTITY_MISMATCH", address);
  id(result.id, address);
  const actualNumber = number(result.number, address);
  if (expectedNumber !== undefined && actualNumber !== expectedNumber)
    fail("GH_IDENTITY_MISMATCH", address);
  checkRepository(result.repository, address);
  checkUrl(result.url, address, actualNumber);
  return result;
}
function checkComment(value: unknown, address: GithubAddress, expectedId?: string): RecordValue {
  const result = record(value, address);
  if (
    result.__typename !== "DiscussionComment" ||
    (expectedId !== undefined && result.id !== expectedId)
  )
    fail("GH_IDENTITY_MISMATCH", address);
  id(result.id, address);
  const discussion = record(result.discussion, address);
  id(discussion.id, address);
  checkRepository(discussion.repository, address);
  checkUrl(result.url, address, number(discussion.number, address));
  return result;
}
function checkThread(value: unknown, address: GithubAddress): RecordValue {
  const result = record(value, address);
  if (result.__typename !== "PullRequestReviewThread" || result.id !== address.parts[3])
    fail("GH_IDENTITY_MISMATCH", address);
  checkRepository(result.repository, address);
  if (
    number(record(result.pullRequest, address).number, address) !==
    number(address.parts[1], address)
  )
    fail("GH_IDENTITY_MISMATCH", address);
  if (typeof result.isResolved !== "boolean") fail("GH_INVALID_RESPONSE", address);
  return result;
}
function page(address: GithubAddress): { first: number; after: string | null } {
  for (const [key] of address.parameters)
    if (!["per_page", "cursor"].includes(key)) fail("GH_INVALID_PAGE", address);
  const first = Number(address.parameters.get("per_page") ?? 30);
  const after = address.parameters.get("cursor");
  if (
    !Number.isInteger(first) ||
    first < 1 ||
    first > 50 ||
    (after !== null && (!after || after.length > 2048))
  )
    fail("GH_INVALID_PAGE", address);
  return { first, after };
}
function connection(
  value: unknown,
  address: GithubAddress,
  maximum: number,
): { nodes: unknown[]; next?: string } {
  const result = record(value, address);
  const info = record(result.pageInfo, address);
  if (
    !Array.isArray(result.nodes) ||
    result.nodes.length > maximum ||
    typeof info.hasNextPage !== "boolean"
  )
    fail("GH_INVALID_RESPONSE", address);
  if (info.hasNextPage) {
    if (
      typeof info.endCursor !== "string" ||
      !info.endCursor ||
      info.endCursor.length > 2048 ||
      info.endCursor === address.parameters.get("cursor")
    )
      fail("GH_INVALID_CONTINUATION", address);
    return { nodes: result.nodes, next: info.endCursor };
  }
  return { nodes: result.nodes };
}
function nextSource(address: GithubAddress, cursor: string, first: number): string {
  return (
    githubSource(address, address.parts.join("/")) +
    "?" +
    new URLSearchParams({ per_page: String(first), cursor })
  );
}
function actionSchema(address: GithubAddress) {
  const path = address.parts.join("/");
  if (path === "discussions/new") return createDiscussionSchema;
  if (/^discussions\/\d+\/comments\/new$/.test(path)) return createCommentSchema;
  if (/^discussion-comments\/[^/]+\/reply$/.test(path)) return commentSchema;
  if (/^pulls\/\d+\/threads\/[^/]+\/(?:resolve|unresolve)$/.test(path)) return emptySchema;
  return undefined;
}
function valid(schema: unknown, value: unknown): boolean {
  return Value.Check(schema as Parameters<typeof Value.Check>[0], value);
}
function input(content: string, schema: unknown, address: GithubAddress): RecordValue {
  let result: unknown;
  try {
    result = JSON.parse(content);
  } catch {
    fail("GH_INVALID_ACTION_INPUT", address);
  }
  if (!Value.Check(schema as Parameters<typeof Value.Check>[0], result))
    fail("GH_INVALID_ACTION_INPUT", address);
  return record(result, address);
}

/** GitHub Discussions and review threads through bounded, repository-verified GraphQL resources. */
export class GithubCollaboration {
  constructor(
    readonly provider: (cwd: string) => Promise<{
      graphql(...args: Parameters<GithubClient["graphql"]>): Promise<unknown>;
    }>,
  ) {}

  /** Claim only this adapter's explicit discussion and PR thread namespace. */
  owns(address: GithubAddress): boolean {
    return (
      ["discussions", "discussion-comments"].includes(address.parts[0]) ||
      (address.parts[0] === "pulls" &&
        /^\d+$/.test(address.parts[1] ?? "") &&
        address.parts[2] === "threads")
    );
  }

  async #query(
    address: GithubAddress,
    cwd: string,
    query: string,
    variables: RecordValue,
    signal?: AbortSignal,
  ): Promise<RecordValue> {
    try {
      return record(await (await this.provider(cwd)).graphql(query, variables, signal), address);
    } catch (error) {
      if (error instanceof GithubApiError)
        throw githubResourceError(error, address.source, "GH_GRAPHQL_REQUEST_FAILED");
      if (error instanceof ResourceError) {
        if (query.startsWith("mutation") && error.code === "GH_INVALID_RESPONSE")
          fail(error.code, address, "unknown");
        throw error;
      }
      fail(
        "GH_GRAPHQL_REQUEST_FAILED",
        address,
        query.startsWith("mutation") ? "unknown" : "not-applied",
      );
    }
  }
  async #discussion(
    address: GithubAddress,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RecordValue> {
    const n = number(address.parts[1], address);
    const result = await this.#query(
      address,
      cwd,
      `query GithubDiscussion($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){${repositoryFields} discussion(number:$number){${discussionFields}}}}`,
      { owner: address.owner, repo: address.repo, number: n },
      signal,
    );
    const repository = checkRepository(result.repository, address);
    return checkDiscussion(repository.discussion, address, n);
  }
  async #comment(
    address: GithubAddress,
    nodeId: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RecordValue> {
    const result = await this.#query(
      address,
      cwd,
      `query GithubDiscussionComment($id:ID!){node(id:$id){__typename ... on DiscussionComment{${commentFields}}}}`,
      { id: nodeId },
      signal,
    );
    return checkComment(result.node, address, nodeId);
  }
  async #thread(address: GithubAddress, cwd: string, signal?: AbortSignal): Promise<RecordValue> {
    const nodeId = id(address.parts[3], address);
    const result = await this.#query(
      address,
      cwd,
      `query GithubThread($id:ID!){node(id:$id){__typename ... on PullRequestReviewThread{${threadFields}}}}`,
      { id: nodeId },
      signal,
    );
    return checkThread(result.node, address);
  }
  async #category(
    address: GithubAddress,
    categoryId: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RecordValue> {
    const result = await this.#query(
      address,
      cwd,
      `query GithubCategory($id:ID!){node(id:$id){__typename ... on DiscussionCategory{id repository{${repositoryFields}}}}}`,
      { id: categoryId },
      signal,
    );
    const category = record(result.node, address);
    if (category.__typename !== "DiscussionCategory" || category.id !== categoryId)
      fail("GH_IDENTITY_MISMATCH", address);
    checkRepository(category.repository, address);
    return category;
  }
  #schema(address: GithubAddress) {
    return address.parts[0] === "discussion-comments"
      ? commentSchema
      : address.parts[0] === "pulls"
        ? threadSchema
        : discussionSchema;
  }
  #actions(address: GithubAddress): string {
    const path = address.parts.join("/");
    const actions =
      address.parts[0] === "discussions"
        ? [path + "/comments/new"]
        : address.parts[0] === "discussion-comments"
          ? [path + "/reply"]
          : [path + "/resolve", path + "/unresolve"];
    return json({
      fields: githubSource(address, path, "fields"),
      schema: githubSource(address, path, "schema"),
      actions: actions.map((value) => githubSource(address, value)),
    });
  }

  /** Read one card/body/field or bounded connection. Linked comments and replies remain separate. */
  async read(address: GithubAddress, cwd: string, signal?: AbortSignal): Promise<GithubSnapshot> {
    signal?.throwIfAborted();
    if (!this.owns(address)) fail("GH_UNSUPPORTED_RESOURCE", address);
    if (address.facet?.startsWith("discussioncomment-"))
      fail("GH_UNSUPPORTED_COMMENT_FRAGMENT", address);
    const schema = actionSchema(address);
    if (schema) {
      if (address.facet && !["schema", "actions"].includes(address.facet))
        fail("GH_UNSUPPORTED_FACET", address);
      return {
        content: json({ source: address.source, tool: "write", input: schema }),
        editable: false,
      };
    }
    const path = address.parts.join("/");
    const entity =
      /^discussions\/\d+$/.test(path) ||
      /^discussion-comments\/[^/]+$/.test(path) ||
      /^pulls\/\d+\/threads\/[^/]+$/.test(path);
    if (entity) {
      if (address.parameters.size) fail("GH_INVALID_PAGE", address);
      if (address.facet === "schema")
        return { content: json(this.#schema(address)), editable: false };
      if (address.facet === "actions") return { content: this.#actions(address), editable: false };
      const data =
        address.parts[0] === "discussions"
          ? await this.#discussion(address, cwd, signal)
          : address.parts[0] === "discussion-comments"
            ? await this.#comment(address, id(address.parts[1], address), cwd, signal)
            : await this.#thread(address, cwd, signal);
      const fields =
        address.parts[0] === "discussions"
          ? { title: data.title, body: data.body, categoryId: record(data.category, address).id }
          : address.parts[0] === "discussion-comments"
            ? { body: data.body }
            : { resolved: data.isResolved };
      const rev = revision(data);
      if (address.facet === "fields")
        return { content: json(fields), editable: true, revision: rev };
      if (address.facet && Object.hasOwn(fields, address.facet)) {
        const value = (fields as RecordValue)[address.facet];
        if ((address.facet === "body" || address.facet === "title") && typeof value !== "string")
          fail("GH_INVALID_RESPONSE", address);
        return {
          content: typeof value === "string" ? value : json(value),
          editable: true,
          revision: rev,
          field: address.facet,
        };
      }
      if (address.facet) fail("GH_UNSUPPORTED_FACET", address);
      const links = [
        `Fields: ${githubSource(address, path, "fields")}`,
        `Schema: ${githubSource(address, path, "schema")}`,
        `Actions: ${githubSource(address, path, "actions")}`,
      ];
      if (address.parts[0] === "discussions")
        links.unshift(
          `Editable body: ${githubSource(address, path, "body")}`,
          `Comments: ${githubSource(address, path + "/comments")}`,
        );
      if (address.parts[0] === "discussion-comments")
        links.unshift(
          `Editable body: ${githubSource(address, path, "body")}`,
          `Replies: ${githubSource(address, path + "/replies")}`,
        );
      if (address.parts[0] === "pulls")
        links.unshift(
          `Resolved: ${githubScalarText(data.isResolved, "unavailable")}`,
          `File: ${githubScalarText(data.path, "unavailable")}`,
          `Line: ${githubScalarText(data.line, "unavailable")}`,
          `PR review comments: ${githubSource(address, `pulls/${address.parts[1]}/comments`)}`,
        );
      const author =
        data.author && typeof data.author === "object" ? (data.author as RecordValue) : undefined;
      const login = author?.login;
      const actorType = author?.__typename;
      return {
        content: [
          `# ${String(data.title ?? data.id)}`,
          `Source: ${address.source}`,
          ...(typeof data.url === "string" && data.url ? [`URL: ${data.url}`] : []),
          ...(typeof login === "string" && login ? [`Author: ${login}`] : []),
          ...(typeof actorType === "string" ? [`Author type: ${actorType}`] : []),
          ...links,
          ...(typeof data.body === "string" ? ["## Body", data.body] : []),
        ].join("\n\n"),
        editable: false,
      };
    }
    if (address.facet) fail("GH_UNSUPPORTED_FACET", address);
    return this.#list(address, cwd, signal);
  }

  async #list(address: GithubAddress, cwd: string, signal?: AbortSignal): Promise<GithubSnapshot> {
    const pagination = page(address);
    const variables = { owner: address.owner, repo: address.repo, ...pagination };
    const path = address.parts.join("/");
    let raw: unknown;
    let rows: (value: unknown) => string;
    if (path === "discussions" || path === "discussions/categories") {
      const categories = path.endsWith("categories");
      const field = categories ? "discussionCategories" : "discussions";
      const selection = categories
        ? `__typename id name isAnswerable repository{${repositoryFields}}`
        : discussionIdentity;
      const result = await this.#query(
        address,
        cwd,
        `query GithubDiscussionPage($owner:String!,$repo:String!,$first:Int!,$after:String){repository(owner:$owner,name:$repo){${repositoryFields} ${field}(first:$first,after:$after){nodes{${selection}} ${pageFields}}}}`,
        variables,
        signal,
      );
      raw = checkRepository(result.repository, address)[field];
      rows = (value) => {
        if (categories) {
          const category = record(value, address);
          if (category.__typename !== "DiscussionCategory") fail("GH_IDENTITY_MISMATCH", address);
          checkRepository(category.repository, address);
          return `- ${String(category.name)}: categoryId ${id(category.id, address)}`;
        }
        const discussion = checkDiscussion(value, address);
        return `- ${String(discussion.title)}: <${githubSource(address, `discussions/${number(discussion.number, address)}`)}>`;
      };
    } else if (/^discussions\/\d+\/comments$/.test(path)) {
      const n = number(address.parts[1], address);
      const result = await this.#query(
        address,
        cwd,
        `query GithubDiscussionComments($owner:String!,$repo:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$repo){${repositoryFields} discussion(number:$number){${discussionIdentity} comments(first:$first,after:$after){nodes{${commentIdentity}} ${pageFields}}}}}`,
        { ...variables, number: n },
        signal,
      );
      const discussion = checkDiscussion(
        checkRepository(result.repository, address).discussion,
        address,
        n,
      );
      raw = discussion.comments;
      rows = (value) => {
        const comment = checkComment(value, address);
        if (record(comment.discussion, address).id !== discussion.id)
          fail("GH_IDENTITY_MISMATCH", address);
        const source = githubSource(address, `discussion-comments/${id(comment.id, address)}`);
        return `- Comment: <${source}>\n  Replies: <${source}/replies>`;
      };
    } else if (/^discussion-comments\/[^/]+\/replies$/.test(path)) {
      const nodeId = id(address.parts[1], address);
      const result = await this.#query(
        address,
        cwd,
        `query GithubDiscussionReplies($id:ID!,$first:Int!,$after:String){node(id:$id){__typename ... on DiscussionComment{${commentIdentity} replies(first:$first,after:$after){nodes{${commentIdentity}} ${pageFields}}}}}`,
        { id: nodeId, ...pagination },
        signal,
      );
      const parent = checkComment(result.node, address, nodeId);
      raw = parent.replies;
      rows = (value) => {
        const reply = checkComment(value, address);
        if (record(reply.discussion, address).id !== record(parent.discussion, address).id)
          fail("GH_IDENTITY_MISMATCH", address);
        return `- Reply: <${githubSource(address, `discussion-comments/${id(reply.id, address)}`)}>`;
      };
    } else if (/^pulls\/\d+\/threads$/.test(path)) {
      const n = number(address.parts[1], address);
      const result = await this.#query(
        address,
        cwd,
        `query GithubThreads($owner:String!,$repo:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$repo){${repositoryFields} pullRequest(number:$number){number reviewThreads(first:$first,after:$after){nodes{${threadFields}} ${pageFields}}}}}`,
        { ...variables, number: n },
        signal,
      );
      const pull = record(checkRepository(result.repository, address).pullRequest, address);
      if (pull.number !== n) fail("GH_IDENTITY_MISMATCH", address);
      raw = pull.reviewThreads;
      rows = (value) => {
        const data = record(value, address);
        const target = { ...address, parts: [...address.parts, id(data.id, address)] };
        const thread = checkThread(value, target);
        return `- ${githubScalarText(thread.path, "unavailable")}:${githubScalarText(thread.line, "file")} resolved=${githubScalarText(thread.isResolved, "unavailable")}: <${githubSource(address, `pulls/${n}/threads/${id(thread.id, address)}`)}>`;
      };
    } else fail("GH_UNSUPPORTED_RESOURCE", address);
    const result = connection(raw, address, pagination.first);
    const next = result.next ? nextSource(address, result.next, pagination.first) : undefined;
    const creation =
      path === "discussions"
        ? githubSource(address, "discussions/new")
        : /^discussions\/\d+\/comments$/.test(path)
          ? githubSource(address, path + "/new")
          : undefined;
    const navigation =
      path === "discussions"
        ? [`Categories: ${githubSource(address, "discussions/categories")}`]
        : [];
    return {
      content: [
        `# ${path}`,
        `Returned: ${result.nodes.length}`,
        next ? `Coverage is incomplete. Next page: <${next}>` : "End of results.",
        ...navigation,
        ...(creation ? [`Create: ${creation}`] : []),
        ...result.nodes.map(rows),
      ].join("\n\n"),
      editable: false,
    };
  }

  /** Compare the fresh revision/content before saving, then verify the acknowledged mutation by rereading. */
  async save(
    address: GithubAddress,
    expected: GithubSnapshot,
    next: string,
    cwd: string,
    signal?: AbortSignal,
    _approve?: GithubApproval,
  ): Promise<GithubSnapshot> {
    if (!expected.editable) fail("GH_READ_ONLY_RESOURCE", address);
    const fresh = await this.read(address, cwd, signal);
    if (
      !fresh.editable ||
      fresh.content !== expected.content ||
      fresh.revision !== expected.revision
    )
      fail("GH_STALE_RESOURCE", address);
    let fields: RecordValue;
    if (expected.field) {
      let value: unknown = next;
      if (expected.field === "resolved") {
        try {
          value = JSON.parse(next);
        } catch {
          fail("GH_INVALID_FIELD_VALUE", address);
        }
      }
      fields = { [expected.field]: value };
    } else {
      try {
        fields = record(JSON.parse(next), address);
      } catch {
        fail("GH_INVALID_FIELD_VALUE", address);
      }
    }
    if (!valid(this.#schema(address), fields)) fail("GH_INVALID_FIELD_VALUE", address);
    let mutation: string;
    let payload: RecordValue;
    if (address.parts[0] === "discussions") {
      const discussion = await this.#discussion(address, cwd, signal);
      if (revision(discussion) !== fresh.revision) fail("GH_STALE_RESOURCE", address);
      if (fields.categoryId)
        await this.#category(address, fields.categoryId as string, cwd, signal);
      payload = { discussionId: discussion.id, ...fields };
      mutation = `mutation GithubUpdateDiscussion($input:UpdateDiscussionInput!){updateDiscussion(input:$input){discussion{${discussionFields}}}}`;
    } else if (address.parts[0] === "discussion-comments") {
      payload = { commentId: id(address.parts[1], address), ...fields };
      mutation = `mutation GithubUpdateDiscussionComment($input:UpdateDiscussionCommentInput!){updateDiscussionComment(input:$input){comment{${commentFields}}}}`;
    } else if (address.parts[0] === "pulls") {
      const thread = await this.#thread(address, cwd, signal);
      if (revision(thread) !== fresh.revision) fail("GH_STALE_RESOURCE", address);
      const resolved = fields.resolved as boolean;
      if (thread.isResolved === resolved) return fresh;
      if (thread[resolved ? "viewerCanResolve" : "viewerCanUnresolve"] === false)
        fail("GH_FORBIDDEN", address);
      const operation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
      payload = { threadId: thread.id };
      mutation = `mutation GithubResolveThread($input:${resolved ? "ResolveReviewThreadInput" : "UnresolveReviewThreadInput"}!){${operation}(input:$input){thread{${threadFields}}}}`;
    } else fail("GH_READ_ONLY_RESOURCE", address);
    await this.#query(address, cwd, mutation, { input: payload }, signal);
    let saved: GithubSnapshot;
    try {
      saved = await this.read(address, cwd, signal);
    } catch (error) {
      throw new ResourceError("GH_SAVE_UNVERIFIED", address.source, "unknown", {
        metadata: githubResourceError(error, address.source, "GH_SAVE_UNVERIFIED").metadata,
      });
    }
    if (expected.field) {
      const wanted =
        typeof fields[expected.field] === "string"
          ? (fields[expected.field] as string)
          : json(fields[expected.field]);
      if (saved.content !== wanted && saved.content !== wanted.replace(/\n$/, ""))
        fail("GH_SAVED_CONTENT_MISMATCH", address, "unknown");
    } else {
      const actual = record(JSON.parse(saved.content), address);
      if (Object.entries(fields).some(([key, value]) => json(actual[key]) !== json(value)))
        fail("GH_SAVED_CONTENT_MISMATCH", address, "unknown");
    }
    return saved;
  }

  /** Perform one exact-key creation or resolution action; node ownership is verified before mutation. */
  async perform(
    address: GithubAddress,
    content: string,
    cwd: string,
    signal?: AbortSignal,
    _approve?: GithubApproval,
  ): Promise<GithubReceipt> {
    if (address.facet || address.parameters.size) fail("GH_UNSUPPORTED_ACTION", address);
    const schema = actionSchema(address);
    if (!schema) fail("GH_UNSUPPORTED_ACTION", address);
    const fields = input(content, schema, address);
    const path = address.parts.join("/");
    if (/^pulls\/\d+\/threads\/[^/]+\/(?:resolve|unresolve)$/.test(path)) {
      const target = {
        ...address,
        parts: address.parts.slice(0, 4),
        source: githubSource(address, address.parts.slice(0, 4).join("/"), "resolved"),
        facet: "resolved",
      };
      const expected = await this.read(target, cwd, signal);
      await this.save(target, expected, json(address.parts[4] === "resolve"), cwd, signal);
      return {
        source: githubSource(address, address.parts.slice(0, 4).join("/")),
        id: address.parts[3],
        effect: "applied",
      };
    }
    let query: string;
    let payload: RecordValue;
    let resultKey: string;
    let entityKey: string;
    let discussionId: string | undefined;
    if (path === "discussions/new") {
      const category = await this.#category(address, fields.categoryId as string, cwd, signal);
      payload = { repositoryId: id(record(category.repository, address).id, address), ...fields };
      query = `mutation GithubCreateDiscussion($input:CreateDiscussionInput!){createDiscussion(input:$input){discussion{${discussionFields}}}}`;
      resultKey = "createDiscussion";
      entityKey = "discussion";
    } else {
      if (address.parts[0] === "discussions") {
        const discussion = await this.#discussion(address, cwd, signal);
        discussionId = id(discussion.id, address);
        if (fields.replyToId) {
          const reply = await this.#comment(address, fields.replyToId as string, cwd, signal);
          if (record(reply.discussion, address).id !== discussionId)
            fail("GH_IDENTITY_MISMATCH", address);
        }
        payload = { discussionId, ...fields };
      } else {
        const reply = await this.#comment(address, id(address.parts[1], address), cwd, signal);
        discussionId = id(record(reply.discussion, address).id, address);
        payload = { discussionId, replyToId: reply.id, ...fields };
      }
      query = `mutation GithubCreateDiscussionComment($input:AddDiscussionCommentInput!){addDiscussionComment(input:$input){comment{${commentFields}}}}`;
      resultKey = "addDiscussionComment";
      entityKey = "comment";
    }
    const response = await this.#query(address, cwd, query, { input: payload }, signal);
    try {
      const value = record(record(response[resultKey], address)[entityKey], address);
      const data =
        entityKey === "discussion" ? checkDiscussion(value, address) : checkComment(value, address);
      if (discussionId && record(data.discussion, address).id !== discussionId)
        fail("GH_IDENTITY_MISMATCH", address);
      const source =
        entityKey === "discussion"
          ? githubSource(address, `discussions/${number(data.number, address)}`)
          : githubSource(address, `discussion-comments/${id(data.id, address)}`);
      const target = parseGithubAddress(source);
      if (!target) fail("GH_INVALID_RESPONSE", address, "unknown");
      const saved = await this.read(
        { ...target, facet: "fields", source: source + "#fields" },
        cwd,
        signal,
      );
      const actual = record(JSON.parse(saved.content), address);
      for (const key of ["body", "title", "categoryId"])
        if (fields[key] !== undefined && actual[key] !== fields[key])
          fail("GH_SAVED_CONTENT_MISMATCH", address, "unknown");
      return { source, id: id(data.id, address), url: data.url as string, effect: "applied" };
    } catch (error) {
      throw new ResourceError("GH_CREATION_UNVERIFIED", address.source, "unknown", {
        metadata: githubResourceError(error, address.source, "GH_CREATION_UNVERIFIED").metadata,
      });
    }
  }

  /** Search only discussions, scoped to one explicit repository, with API cursors and no content crawl. */
  async discover(
    request: GithubObjectSearch,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GithubObjectPage> {
    const address = parseGithubAddress(request.scope);
    if (
      !address ||
      request.kind !== "discussions" ||
      address.facet ||
      (address.parts.length && address.parts.join("/") !== "search") ||
      request.repository.toLowerCase() !== `${address.owner}/${address.repo}`.toLowerCase()
    )
      throw new ResourceError("GH_INVALID_SEARCH_SCOPE", request.scope, "not-applied");
    if (/(?:^|[\s(])[-+]?(?:repo|org|user):/i.test(request.term) || request.term.length > 4096)
      fail("GH_SEARCH_SCOPE_OVERRIDE", address);
    if (!Number.isInteger(request.limit) || request.limit < 1) fail("GH_INVALID_PAGE", address);
    const first = Math.min(request.limit, 50);
    const after = address.parameters.get("cursor");
    if (after !== null && (!after || after.length > 2048)) fail("GH_INVALID_PAGE", address);
    for (const [key] of address.parameters)
      if (!["cursor", "per_page", "kind", "q"].includes(key)) fail("GH_INVALID_PAGE", address);
    const result = await this.#query(
      address,
      cwd,
      `query GithubDiscussionSearch($query:String!,$first:Int!,$after:String){search(query:$query,type:DISCUSSION,first:$first,after:$after){discussionCount nodes{__typename ... on Discussion{${discussionIdentity}}} ${pageFields}}}`,
      { query: `repo:${address.owner}/${address.repo} ${request.term}`.trim(), first, after },
      signal,
    );
    const raw = record(result.search, address);
    if (!Number.isSafeInteger(raw.discussionCount) || Number(raw.discussionCount) < 0)
      fail("GH_INVALID_RESPONSE", address);
    const found = connection(raw, address, first);
    const items = found.nodes.map((value) => {
      const discussion = checkDiscussion(value, address);
      if (typeof discussion.title !== "string") fail("GH_INVALID_RESPONSE", address);
      return {
        id: id(discussion.id, address),
        title: discussion.title,
        url: githubSource(address, `discussions/${number(discussion.number, address)}`),
      };
    });
    const next = found.next
      ? githubSource(address, "search") +
        "?" +
        new URLSearchParams({
          kind: "discussions",
          q: request.term,
          per_page: String(first),
          cursor: found.next,
        })
      : undefined;
    return {
      kind: "discussions",
      repository: `${address.owner}/${address.repo}`,
      term: request.term,
      items,
      complete: !next && Number(raw.discussionCount) <= 1000,
      ...(next ? { next } : {}),
      notice:
        Number(raw.discussionCount) > 1000
          ? "GitHub search has a 1,000-result ceiling. Coverage is incomplete; no recursive scan was made."
          : "Native GitHub GraphQL discussion search; comment bodies and replies stay separate.",
    };
  }
}
