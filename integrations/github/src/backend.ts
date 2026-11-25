import { createHash } from "node:crypto";
import { discoverGithub } from "./discovery.ts";
import { githubScalarText } from "./api.ts";
import type { GithubObjectPage, GithubObjectSearch } from "./search.ts";
import type { GithubCollaboration } from "./collaboration.ts";
import { Value } from "typebox/value";
import { ResourceError } from "pi-agent-ide/api/resource";
import { GithubApiError, type GithubClient } from "./client.ts";
import { githubResourceError } from "./resource-error.ts";
import { githubSource, parseGithubAddress, type GithubAddress } from "./address.ts";
import { actionRoute, collectionRoute, entityRoute, type GithubEntityRoute } from "./routes.ts";

/** A canonical resource snapshot; revision checks are pre-save checks, not remote atomic CAS. */
export interface GithubSnapshot {
  readonly content: string;
  readonly editable: boolean;
  readonly bytes?: Uint8Array;
  readonly revision?: string;
  readonly field?: string;
}
/** One verified mutation receipt. Unknown effects throw instead of inviting a duplicate write. */
export interface GithubReceipt {
  readonly source: string;
  readonly url?: string;
  readonly id?: string;
  readonly effect: "applied";
}
/** User approval for one exact remote action. Headless callers must deny dangerous effects. */
export type GithubApproval = (source: string, action: string) => Promise<boolean>;
/** Authentication remains behind this lazy, session-owned client boundary. */
export type GithubClientProvider = (cwd: string) => Promise<GithubClient>;

/** REST methods return upstream data whose shape must be checked at the consumer boundary. */
export interface GithubRestReader {
  rest(...args: Parameters<GithubClient["rest"]>): ReturnType<GithubClient["rest"]>;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);
const hash = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
function fail(
  code: string,
  source: string,
  effect: "not-applied" | "unknown" = "not-applied",
): never {
  throw new ResourceError(code, source, effect);
}
function record(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("GH_INVALID_RESPONSE", source);
  return value as Record<string, unknown>;
}
function projection(
  data: Record<string, unknown>,
  route: GithubEntityRoute,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(route.schema.properties)) {
    let value = data[key];
    if (key === "body" && value === null) value = "";
    if (["labels", "assignees"].includes(key) && Array.isArray(value))
      value = value.map((item) =>
        typeof item === "string"
          ? item
          : (item as Record<string, unknown>)[key === "labels" ? "name" : "login"],
      );
    if (key === "milestone" && value && typeof value === "object")
      value = (value as Record<string, unknown>).number;
    if (key === "base" && value && typeof value === "object")
      value = (value as Record<string, unknown>).ref;
    if (value !== undefined) result[key] = value;
  }
  return result;
}
function nativeUrl(address: GithubAddress, data: Record<string, unknown>): string | undefined {
  const raw = data.html_url;
  if (typeof raw !== "string") return undefined;
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname.split("/")[1]?.toLowerCase() !== address.owner ||
    url.pathname.split("/")[2]?.toLowerCase() !== address.repo.toLowerCase()
  )
    fail("GH_IDENTITY_MISMATCH", address.source);
  return raw;
}

/** Adapt explicit GitHub resources to cards, typed fields, body snapshots and closed actions. */
export class GithubBackend {
  constructor(
    readonly client: GithubClientProvider,
    readonly collaboration?: GithubCollaboration,
  ) {}

  /** Native discovery is distinct from text matching inside a selected resource. */
  async discover(
    request: GithubObjectSearch,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GithubObjectPage> {
    if (request.kind === "discussions" && this.collaboration)
      return this.collaboration.discover(request, cwd, signal);
    return discoverGithub(this.client, request, cwd, signal);
  }

  async #rest(
    address: GithubAddress,
    cwd: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; next?: string }> {
    try {
      return await (
        await this.client(cwd)
      ).rest(
        method,
        `/repos/${address.owner}/${address.repo}${path ? "/" + path : ""}`,
        body,
        signal,
      );
    } catch (error) {
      if (error instanceof GithubApiError)
        throw githubResourceError(error, address.source, "GH_REQUEST_FAILED");
      throw error;
    }
  }

  /** Read exactly one resource; bodies behind displayed links stay lazy. */
  async read(address: GithubAddress, cwd: string, signal?: AbortSignal): Promise<GithubSnapshot> {
    signal?.throwIfAborted();
    if (this.collaboration?.owns(address)) return this.collaboration.read(address, cwd, signal);
    if (address.parts.join("/") === "search") {
      const page = await this.discover(
        {
          kind: address.parameters.get("kind") ?? "",
          term: address.parameters.get("q") ?? "",
          repository: `${address.owner}/${address.repo}`,
          scope: address.source,
          limit: Number(address.parameters.get("per_page") ?? 30),
        },
        cwd,
        signal,
      );
      return {
        content: [
          `# GitHub ${page.kind}: ${page.term}`,
          `Returned: ${page.items.length}`,
          page.complete ? "End of results." : "Coverage is incomplete.",
          ...(page.next ? [`Next page: <${page.next}>`] : []),
          ...page.items.map((item) => `- ${item.title}: <${item.url}>`),
        ].join("\n\n"),
        editable: false,
      };
    }
    const action = actionRoute(address);
    if (address.parameters.size && (action || entityRoute(address)))
      fail("GH_UNSUPPORTED_QUERY", address.source);
    if (action)
      return {
        content: json({
          source: address.source,
          tool: "write",
          input: action.schema,
          ...(action.dangerous ? { approval: "Exact target and action approval required" } : {}),
        }),
        editable: false,
      };
    const route = entityRoute(address);
    if (route) {
      if (address.facet === "schema") return { content: json(route.schema), editable: false };
      if (address.facet === "actions") return { content: this.#actions(address), editable: false };
      const data = record(
        (await this.#rest(address, cwd, "GET", route.path, undefined, signal)).data,
        address.source,
      );
      nativeUrl(address, data);
      const identityKey = ["issue", "pull request", "milestone"].includes(route.kind)
        ? "number"
        : route.kind === "label"
          ? "name"
          : route.kind === "repository"
            ? "full_name"
            : "id";
      const identity =
        route.kind === "repository" ? `${address.owner}/${address.repo}` : address.parts.at(-1);
      if (identity === undefined) fail("GH_IDENTITY_MISMATCH", address.source);
      if (String(data[identityKey]).toLowerCase() !== identity.toLowerCase())
        fail("GH_IDENTITY_MISMATCH", address.source);
      const fields = projection(data, route);
      const revision = hash(data);
      if (address.facet === "body" && route.body)
        return {
          content: typeof data.body === "string" ? data.body : "",
          editable: true,
          revision,
          field: "body",
        };
      if (address.facet === "fields")
        return { content: json(fields), editable: !!route.updateMethod, revision };
      if (address.facet && Object.hasOwn(route.schema.properties, address.facet)) {
        const value = fields[address.facet] ?? null;
        return {
          content: typeof value === "string" ? value : json(value),
          editable: !!route.updateMethod,
          revision,
          field: address.facet,
        };
      }
      if (address.facet) fail("GH_UNSUPPORTED_FACET", address.source);
      return { content: this.#card(address, route, data), editable: false };
    }
    const collection = collectionRoute(address);
    if (collection && !address.facet) {
      const query = new URLSearchParams(address.parameters);
      for (const [key] of query)
        if (!["page", "per_page", "state", "sort", "direction"].includes(key))
          fail("GH_UNSUPPORTED_QUERY", address.source);
      const page = Number(query.get("page") ?? 1);
      const size = Number(query.get("per_page") ?? 30);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 50
      )
        fail("GH_INVALID_PAGE", address.source);
      query.set("per_page", String(size));
      const result = await this.#rest(
        address,
        cwd,
        "GET",
        `${collection}?${query}`,
        undefined,
        signal,
      );
      if (!Array.isArray(result.data) || result.data.length > size)
        fail("GH_INVALID_RESPONSE", address.source);
      let head: string | undefined;
      if (collection.endsWith("/files")) {
        const pull = record(
          (
            await this.#rest(
              address,
              cwd,
              "GET",
              address.parts.slice(0, 2).join("/"),
              undefined,
              signal,
            )
          ).data,
          address.source,
        );
        head =
          pull.head &&
          typeof pull.head === "object" &&
          typeof (pull.head as Record<string, unknown>).sha === "string"
            ? String((pull.head as Record<string, unknown>).sha)
            : undefined;
      }
      const rows = result.data.map((value) =>
        this.#row(address, collection, record(value, address.source), head),
      );
      const next = result.next
        ? await this.#continuation(address, result.next, cwd, signal)
        : undefined;
      const creation = actionRoute({ ...address, parts: [...address.parts, "new"] });
      return {
        content: [
          `# ${address.repo}: ${collection}`,
          `Returned: ${rows.length}`,
          next ? `Coverage is incomplete. Next page: <${next}>` : "End of results.",
          ...(creation ? [`Create: ${githubSource(address, collection + "/new")}`] : []),
          ...rows,
        ].join("\n\n"),
        editable: false,
      };
    }
    if (address.parts.join("/") === "file") return this.#file(address, cwd, signal);
    fail("GH_UNSUPPORTED_RESOURCE", address.source);
  }

  /** Reread before one save and verify the saved payload afterward; never replay unknown effects. */
  async save(
    address: GithubAddress,
    expected: GithubSnapshot,
    next: string,
    cwd: string,
    signal?: AbortSignal,
    approve: GithubApproval = async () => false,
  ): Promise<GithubSnapshot> {
    if (this.collaboration?.owns(address))
      return this.collaboration.save(address, expected, next, cwd, signal, approve);
    const route = entityRoute(address);
    if (!route?.updateMethod || !expected.editable) fail("GH_READ_ONLY_RESOURCE", address.source);
    const fresh = await this.read(address, cwd, signal);
    if (fresh.content !== expected.content || fresh.revision !== expected.revision)
      fail("GH_STALE_RESOURCE", address.source);
    let input: Record<string, unknown>;
    if (expected.field) {
      let value: unknown = next;
      if (expected.field !== "body") {
        try {
          value = JSON.parse(next);
        } catch {
          value = next.replace(/\n$/, "");
        }
      }
      input = { [expected.field]: value };
    } else {
      try {
        input = record(JSON.parse(next), address.source);
      } catch {
        fail("GH_INVALID_FIELD_VALUE", address.source);
      }
    }
    if (!Value.Check(route.schema, input)) fail("GH_INVALID_FIELD_VALUE", address.source);
    if (
      route.kind === "release" &&
      input.draft === false &&
      !(await approve(address.source, "publish release"))
    )
      fail("GH_APPROVAL_REQUIRED", address.source);
    await this.#rest(address, cwd, route.updateMethod, route.path, input, signal);
    let saved: GithubSnapshot;
    try {
      saved = await this.read(address, cwd, signal);
    } catch (error) {
      throw new ResourceError("GH_SAVE_UNVERIFIED", address.source, "unknown", {
        metadata: githubResourceError(error, address.source, "GH_SAVE_UNVERIFIED").metadata,
      });
    }
    if (expected.field) {
      if (saved.content !== next && saved.content !== next.replace(/\n$/, ""))
        fail("GH_SAVED_CONTENT_MISMATCH", address.source, "unknown");
    } else {
      const values = JSON.parse(saved.content) as Record<string, unknown>;
      if (Object.entries(input).some(([key, value]) => json(values[key]) !== json(value)))
        fail("GH_SAVED_CONTENT_MISMATCH", address.source, "unknown");
    }
    return saved;
  }

  /** Perform one schema-checked creation/action through ordinary Write, after required approval. */
  async perform(
    address: GithubAddress,
    content: string,
    cwd: string,
    signal?: AbortSignal,
    approve: GithubApproval = async () => false,
  ): Promise<GithubReceipt> {
    if (this.collaboration?.owns(address))
      return this.collaboration.perform(address, content, cwd, signal, approve);
    const route = actionRoute(address);
    if (!route) fail("GH_UNSUPPORTED_ACTION", address.source);
    if (address.parameters.size || address.facet) fail("GH_UNSUPPORTED_QUERY", address.source);
    let input: Record<string, unknown>;
    try {
      input = record(JSON.parse(content), address.source);
    } catch {
      fail("GH_INVALID_ACTION_INPUT", address.source);
    }
    if (!Value.Check(route.schema, input)) fail("GH_INVALID_ACTION_INPUT", address.source);
    const dangerous =
      route.dangerous ||
      (route.kind === "review" && input.event !== undefined) ||
      (route.kind === "release" && input.draft !== true);
    if (dangerous && !(await approve(address.source, route.kind)))
      fail("GH_APPROVAL_REQUIRED", address.source);
    const result = await this.#rest(address, cwd, route.method, route.path, input, signal);
    try {
      const data = record(result.data, address.source);
      const url = nativeUrl(address, data);
      const id = Number.isSafeInteger(data.id) && Number(data.id) > 0 ? String(data.id) : undefined;
      let source: string | undefined;
      if (
        ["issue", "pull request"].includes(route.kind) &&
        Number.isSafeInteger(data.number) &&
        Number(data.number) > 0
      )
        source = githubSource(
          address,
          `${route.kind === "issue" ? "issues" : "pulls"}/${String(data.number)}`,
        );
      else if (route.kind === "comment" && id)
        source = githubSource(address, `issues/comments/${id}`);
      else if (["review comment", "review reply"].includes(route.kind) && id)
        source = githubSource(address, `pulls/comments/${id}`);
      else if (route.kind === "release" && id) source = githubSource(address, `releases/${id}`);
      else if (route.kind === "review" && id) source = githubSource(address, route.path + "/" + id);
      else if (route.kind === "label" && typeof data.name === "string")
        source = githubSource(address, `labels/${encodeURIComponent(data.name)}`);
      else if (route.kind === "milestone" && Number.isSafeInteger(data.number))
        source = githubSource(address, `milestones/${String(data.number)}`);
      else if (route.kind === "review submission")
        source = githubSource(address, route.path.replace(/\/events$/, ""));
      else if (route.kind === "merge") {
        if (data.merged !== true) fail("GH_MERGE_NOT_CONFIRMED", address.source, "unknown");
        source = githubSource(address, address.parts.slice(0, 2).join("/"));
      }
      if (!source || !parseGithubAddress(source))
        fail("GH_INVALID_RECEIPT", address.source, "unknown");
      return { source, ...(url ? { url } : {}), ...(id ? { id } : {}), effect: "applied" };
    } catch {
      fail("GH_INVALID_RECEIPT", address.source, "unknown");
    }
  }

  #actions(address: GithubAddress): string {
    const path = address.parts.join("/");
    const actions: string[] = [];
    if (!path)
      actions.push("issues/new", "pulls/new", "releases/new", "labels/new", "milestones/new");
    if (/^issues\/\d+$/.test(path)) actions.push(path + "/comments/new");
    if (/^pulls\/\d+$/.test(path))
      actions.push(
        `issues/${address.parts[1]}/comments/new`,
        path + "/comments/new",
        path + "/reviews/new",
        path + "/merge",
      );
    if (/^pulls\/\d+\/reviews\/\d+$/.test(path)) actions.push(path + "/submit");
    return json({
      fields: githubSource(address, path, "fields"),
      schema: githubSource(address, path, "schema"),
      actions: actions.map((value) => githubSource(address, value)),
    });
  }
  #card(address: GithubAddress, route: GithubEntityRoute, data: Record<string, unknown>): string {
    const path = address.parts.join("/");
    const links = [
      `Fields: ${githubSource(address, path, "fields")}`,
      `Schema: ${githubSource(address, path, "schema")}`,
      `Actions: ${githubSource(address, path, "actions")}`,
    ];
    if (route.body) links.unshift(`Editable body: ${githubSource(address, path, "body")}`);
    if (!path) {
      for (const kind of ["issues", "pulls", "discussions", "releases", "labels", "milestones"])
        links.push(`${kind}: ${githubSource(address, kind)}`);
      for (const kind of [
        "branches",
        "commits",
        "actions/workflows",
        "actions/runs",
        "deployments",
      ])
        links.push(
          `${kind}: https://api.github.com/repos/${address.owner}/${address.repo}/${kind}`,
        );
      links.push("Other API resources: github://api");
    }
    if (/^issues\/\d+$/.test(path))
      links.push(`Comments: ${githubSource(address, path + "/comments")}`);
    if (/^pulls\/\d+$/.test(path)) {
      links.push(`Conversation: ${githubSource(address, `issues/${address.parts[1]}/comments`)}`);
      links.push(
        `Issue metadata: ${githubSource(address, `issues/${address.parts[1]}`, "fields")}`,
      );
      links.push(`Checks and status: ${githubSource(address, path + "/checks")}`);
      for (const kind of ["comments", "reviews", "files", "commits", "threads"])
        links.push(`${kind}: ${githubSource(address, path + "/" + kind)}`);
    }
    if (route.kind === "release") links.push(`Assets: ${githubSource(address, path + "/assets")}`);
    if (route.kind === "review comment" && typeof data.pull_request_url === "string") {
      const pull = new URL(data.pull_request_url);
      const prefix = `/repos/${address.owner}/${address.repo}/pulls/`;
      const pullNumber = pull.pathname.slice(prefix.length);
      const rootId = data.in_reply_to_id ?? data.id;
      if (
        pull.origin !== "https://api.github.com" ||
        !pull.pathname.startsWith(prefix) ||
        !/^\d+$/.test(pullNumber) ||
        !Number.isSafeInteger(rootId) ||
        Number(rootId) < 1
      )
        fail("GH_IDENTITY_MISMATCH", address.source);
      links.push(
        `Reply to top-level comment: ${githubSource(address, `pulls/${pullNumber}/comments/${String(rootId)}/replies/new`)}`,
      );
    }
    const actor = data.user ?? data.author;
    const author =
      actor && typeof actor === "object" ? (actor as Record<string, unknown>).login : undefined;
    const context: string[] = [];
    if (route.kind === "pull request") {
      for (const side of ["head", "base"]) {
        const branch = data[side];
        if (!branch || typeof branch !== "object" || Array.isArray(branch)) continue;
        const value = branch as Record<string, unknown>;
        if (typeof value.ref === "string")
          context.push(`${side === "head" ? "Head" : "Base"} branch: ${value.ref}`);
        if (side === "head" && typeof value.sha === "string")
          context.push(`Head SHA: ${value.sha}`);
      }
    }
    if (route.kind === "review comment") {
      if (typeof data.path === "string") context.push(`File: ${data.path}`);
      if (data.line !== undefined)
        context.push(`Line: ${githubScalarText(data.line, "unavailable")}`);
      if (typeof data.commit_id === "string") context.push(`Commit: ${data.commit_id}`);
    }
    return [
      `# ${githubScalarText(data.title ?? data.name ?? data.full_name, route.kind)}`,
      `Source: ${address.source}`,
      ...(typeof data.html_url === "string" ? [`URL: ${data.html_url}`] : []),
      ...(typeof data.state === "string" ? [`State: ${data.state}`] : []),
      ...(typeof data.draft === "boolean" ? [`Draft: ${data.draft}`] : []),
      ...context,
      ...(typeof author === "string" && author ? [`Author: ${author}`] : []),
      ...(typeof data.updated_at === "string" && data.updated_at
        ? [`Updated: ${data.updated_at}`]
        : []),
      ...links,
      ...(route.body ? ["## Body", githubScalarText(data.body, "")] : []),
    ].join("\n\n");
  }
  #row(
    address: GithubAddress,
    collection: string,
    data: Record<string, unknown>,
    head?: string,
  ): string {
    const url = nativeUrl(address, data);
    if (collection.endsWith("/files") && typeof data.filename === "string") {
      const source = head
        ? githubSource(address, "file") +
          "?" +
          new URLSearchParams({ ref: head, path: data.filename })
        : undefined;
      return `- ${data.filename}${source ? `: <${source}>` : ": file content requires the PR head SHA."}\n${typeof data.patch === "string" ? data.patch : "No text patch is available (binary or API omitted patch)."}`;
    }
    let path: string | undefined;
    const id = githubScalarText(data.id, "");
    const number = githubScalarText(data.number, "");
    if ((collection === "issues" || collection === "pulls") && /^\d+$/.test(number))
      path = `${data.pull_request || collection === "pulls" ? "pulls" : "issues"}/${number}`;
    else if (collection === "labels" && typeof data.name === "string")
      path = `labels/${encodeURIComponent(data.name)}`;
    else if (collection === "milestones" && /^\d+$/.test(number)) path = `milestones/${number}`;
    else if (/^\d+$/.test(id)) {
      if (/^issues\/\d+\/comments$/.test(collection)) path = `issues/comments/${id}`;
      else if (/^pulls\/\d+\/comments$/.test(collection)) path = `pulls/comments/${id}`;
      else if (collection === "releases") path = `releases/${id}`;
      else if (collection.endsWith("/assets")) path = `releases/assets/${id}`;
      else if (collection.endsWith("/reviews")) path = `${collection}/${id}`;
    }
    const source = path ? githubSource(address, path) : undefined;
    return `- ${githubScalarText(data.title ?? data.name ?? data.id ?? data.sha, "Resource")}${source ? `: <${source}>` : url ? `: <${url}>` : " (no addressable entity)"}`;
  }
  async #continuation(
    address: GithubAddress,
    raw: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = new URL(raw);
    const collection = address.parts.join("/");
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash)
      fail("GH_INVALID_CONTINUATION", address.source);
    const named = `/repos/${address.owner}/${address.repo}/${collection}`;
    if (url.pathname.toLowerCase() !== named.toLowerCase()) {
      if (!/^\/repositories\/\d+\//.test(url.pathname))
        fail("GH_INVALID_CONTINUATION", address.source);
      const repository = record(
        (await this.#rest(address, cwd, "GET", "", undefined, signal)).data,
        address.source,
      );
      if (
        !Number.isSafeInteger(repository.id) ||
        Number(repository.id) < 1 ||
        typeof repository.full_name !== "string" ||
        repository.full_name.toLowerCase() !== `${address.owner}/${address.repo}`.toLowerCase() ||
        url.pathname.toLowerCase() !==
          `/repositories/${String(repository.id)}/${collection}`.toLowerCase()
      )
        fail("GH_INVALID_CONTINUATION", address.source);
    }
    const page = Number(url.searchParams.get("page"));
    if (
      !Number.isSafeInteger(page) ||
      page <= Number(address.parameters.get("page") ?? 1) ||
      url.searchParams.get("per_page") !== (address.parameters.get("per_page") ?? "30")
    )
      fail("GH_INVALID_CONTINUATION", address.source);
    for (const key of ["state", "sort", "direction"])
      if (url.searchParams.get(key) !== address.parameters.get(key))
        fail("GH_INVALID_CONTINUATION", address.source);
    const next = githubSource(address, collection) + url.search;
    if (!parseGithubAddress(next)) fail("GH_INVALID_CONTINUATION", address.source);
    return next;
  }
  async #file(address: GithubAddress, cwd: string, signal?: AbortSignal): Promise<GithubSnapshot> {
    for (const [key] of address.parameters)
      if (!["path", "ref"].includes(key)) fail("GH_UNSUPPORTED_QUERY", address.source);
    const path = address.parameters.get("path");
    const ref = address.parameters.get("ref");
    if (!path || !ref || path.split("/").some((part) => !part || /^\.{1,2}$/.test(part)))
      fail("GH_EXPLICIT_FILE_REF_REQUIRED", address.source);
    const data = record(
      (
        await this.#rest(
          address,
          cwd,
          "GET",
          `contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
          undefined,
          signal,
        )
      ).data,
      address.source,
    );
    if (data.type !== "file" || (data.path !== undefined && data.path !== path))
      fail("GH_IDENTITY_MISMATCH", address.source);
    let bytes: Uint8Array;
    if (data.encoding === "base64" && typeof data.content === "string") {
      const encoded = data.content.replace(/\s/gu, "");
      bytes = Buffer.from(encoded, "base64");
      if (Buffer.from(bytes).toString("base64") !== encoded)
        fail("GH_INVALID_RESPONSE", address.source);
    } else if (data.encoding === "none") {
      try {
        bytes = (
          await (
            await this.client(cwd)
          ).request(
            "GET",
            `/repos/${address.owner}/${address.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
            undefined,
            signal,
            { accept: "application/vnd.github.raw+json" },
          )
        ).bytes;
      } catch (error) {
        if (error instanceof GithubApiError)
          throw githubResourceError(error, address.source, "GH_REQUEST_FAILED");
        throw error;
      }
    } else fail("GH_FILE_CONTENT_UNAVAILABLE", address.source);
    if (bytes.length > 2 * 1024 * 1024 || (data.size !== undefined && data.size !== bytes.length))
      fail("GH_INVALID_RESPONSE", address.source);
    if (
      data.sha !== undefined &&
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== data.sha
    )
      fail("GH_IDENTITY_MISMATCH", address.source);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        content: `Binary file; use raw:${address.source} for original bytes.`,
        editable: false,
        bytes,
      };
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content))
      content = `Binary file; use raw:${address.source} for original bytes.`;
    return { content, editable: false, bytes };
  }
}
