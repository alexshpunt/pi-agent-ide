import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ResourceError, type ResourceResolver } from "pi-agent-ide/api/resource";
import { GithubApiError, type GithubClient, type GithubResponse as ApiResponse } from "./client.ts";
import type { GithubRestReader } from "./backend.ts";
import { githubResourceError } from "./resource-error.ts";

type GithubApiClient = GithubRestReader & Pick<GithubClient, "request">;

const apiOrigin = "https://api.github.com";
const restSource = "github://api/rest";
const graphqlSource = "github://api/graphql";
const resultPrefix = "github://api/results/";
const maximumRequestBytes = 2 * 1024 * 1024;
const maximumResults = 16;
const maximumStoredBytes = 32 * 1024 * 1024;
const paginationKeys = new Set(["page", "cursor", "before", "after"]);

const restSchema = Type.Object(
  {
    method: Type.Union(
      ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map((method) =>
        Type.Literal(method),
      ),
    ),
    path: Type.String({
      description:
        "API path, or an exact https://api.github.com URL. Use the selected GitHub connection; omit credentials.",
      minLength: 1,
    }),
    body: Type.Optional(Type.Unknown({ description: "JSON request body. Omit for GET and HEAD." })),
    accept: Type.Optional(
      Type.String({
        description: "GitHub response media type. Omit to use application/vnd.github+json.",
        maxLength: 200,
      }),
    ),
  },
  { additionalProperties: false },
);
const graphqlSchema = Type.Object(
  {
    query: Type.String({
      description: "Send a GraphQL query or mutation. Raw mutations run in YOLO mode.",
      minLength: 1,
    }),
    variables: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    operationName: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

interface ApiSnapshot {
  readonly source: string;
  readonly request: string;
  readonly response: ApiResponse;
  readonly next?: string;
}
/** A completed raw request receipt, not a claim that a business operation passed its own checks. */
export interface GithubApiReceipt {
  readonly source: string;
  readonly status: number;
  readonly effect: "applied";
}

function fail(
  code: string,
  source: string,
  effect: "not-applied" | "unknown" = "not-applied",
): never {
  throw new ResourceError(code, source, effect);
}
/** Validate an API resource without permitting another identity, host or URL secret. */
export function githubApiUrl(source: string): string {
  if (
    typeof source !== "string" ||
    /[\\\u0000-\u0020\u007f]/u.test(source) ||
    !(source.startsWith("/") || source.startsWith(`${apiOrigin}/`))
  )
    fail("GH_INVALID_ROUTE", source);
  let url: URL;
  try {
    url = new URL(source, apiOrigin);
  } catch {
    fail("GH_INVALID_ROUTE", source);
  }
  if (url.origin !== apiOrigin || url.username || url.password || url.hash)
    fail("GH_INVALID_ROUTE", source);
  for (const key of url.searchParams.keys()) {
    if (/^(?:access_token|authorization|client_secret|client_id|token)$/iu.test(key))
      fail("GH_CREDENTIAL_OVERRIDE", apiOrigin);
  }
  return url.href;
}
/** Recognize only the universal API endpoints and session response resources. */
export function isGithubApiResource(source: string): boolean {
  return (
    source === "github://api" ||
    source === restSource ||
    source === graphqlSource ||
    source.startsWith(resultPrefix) ||
    source.startsWith(`${apiOrigin}/`)
  );
}
function input(
  source: string,
  content: string,
  schema: typeof restSchema | typeof graphqlSchema,
): Record<string, unknown> {
  if (Buffer.byteLength(content) > maximumRequestBytes) fail("GH_CONTENT_TOO_LARGE", source);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    fail("GH_INVALID_INPUT", source);
  }
  if (!Value.Check(schema, value)) fail("GH_INVALID_INPUT", source);
  return value;
}
const secretQueryKey = /(?:^|[-_])(?:token|signature|secret|credential|sig)(?:$|[-_])/iu;
function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"'\\]+/gu, (value) => {
    try {
      const url = new URL(value);
      let redacted = false;
      for (const key of url.searchParams.keys()) {
        if (secretQueryKey.test(key)) {
          url.searchParams.set(key, "[redacted]");
          redacted = true;
        }
      }
      if (url.username || url.password) {
        url.username = "";
        url.password = "";
        redacted = true;
      }
      return redacted ? url.href : value;
    } catch {
      return value;
    }
  });
}
/** Render only scalar fields in summary cards; keep objects in structured views. */
export function githubScalarText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/** Format API metadata without copying signed URL credentials into ordinary presentation. Raw bytes remain separate. */
export function githubJsonText(data: unknown): string {
  return JSON.stringify(
    data,
    (_key, value: unknown) => (typeof value === "string" ? redactUrls(value) : value),
    2,
  );
}
function responseText(response: ApiResponse): { text?: string; data?: unknown; notice?: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
  } catch {
    return {
      notice: "This binary format is not extracted. Read the raw resource for original bytes.",
    };
  }
  if (
    /\b(?:json|\+json)\b/iu.test(response.contentType) &&
    !/^application\/vnd\.github\.raw(?:\+json)?(?:;|$)/iu.test(response.contentType)
  ) {
    if (!text.trim()) return { text: "" };
    try {
      const data: unknown = JSON.parse(text);
      let pretty: string;
      try {
        pretty = githubJsonText(data);
      } catch {
        return {
          data,
          notice:
            "This JSON is too deeply nested to present safely. Read its original bytes through the raw resource.",
        };
      }
      return {
        text:
          Buffer.byteLength(pretty) < maximumRequestBytes
            ? pretty
            : JSON.stringify(JSON.parse(pretty)),
        data,
      };
    } catch {
      return {
        notice:
          "The API advertised JSON, but returned invalid JSON. Inspect its original bytes before deciding what happened.",
      };
    }
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || /^(?:PK|%PDF-)/u.test(text))
    return {
      notice:
        "This binary/archive format is not extracted. Read the raw resource for original bytes.",
    };
  return { text: redactUrls(text) };
}
function navigation(data: unknown): string[] {
  const urls = new Set<string>();
  const queue: unknown[] = [data];
  for (let index = 0; index < queue.length && index < 10_000; index++) {
    const item = queue[index];
    if (typeof item === "string" && /^https:\/\/(?:api\.github\.com|github\.com)\//u.test(item)) {
      try {
        const url = new URL(item);
        if (
          !/[{}]/u.test(decodeURI(url.href)) &&
          !url.username &&
          !url.password &&
          !url.port &&
          ![...url.searchParams.keys()].some((key) => secretQueryKey.test(key))
        )
          urls.add(url.href);
      } catch {
        /* A field is not automatically a usable link. */
      }
    } else if (item && typeof item === "object") {
      const children: unknown[] = Array.isArray(item) ? item : Object.values(item);
      queue.push(...children.slice(0, 1000));
    }
    if (urls.size === 100) break;
  }
  return [...urls];
}
function render(snapshot: ApiSnapshot): string {
  const { response } = snapshot;
  const value = responseText(response);
  const links = navigation(value.data);
  return [
    "# GitHub API resource",
    `Resource: ${snapshot.source}`,
    `Request: ${snapshot.request}`,
    `Status: ${response.status}`,
    `Content type: ${response.contentType || "unspecified"}`,
    `Original bytes: ${response.bytes.byteLength}; raw:${snapshot.source}`,
    ...(snapshot.next
      ? [`Next page: <${snapshot.next}>`, "Coverage is incomplete; follow the exact next link."]
      : []),
    ...(links.length ? ["", "## Links", ...links.map((link) => `- <${link}>`)] : []),
    ...(value.notice ? ["", value.notice] : []),
    ...(value.text !== undefined ? ["", "## Response", value.text] : []),
  ].join("\n");
}
function sinceCursor(url: URL): boolean {
  return ["/repositories", "/users", "/organizations"].includes(url.pathname);
}
function filters(url: URL): string {
  return JSON.stringify(
    [...url.searchParams]
      .filter(([key]) => !paginationKeys.has(key) && !(key === "since" && sinceCursor(url)))
      .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)),
  );
}
function samePage(current: URL, next: URL): boolean {
  const nextValue = next.searchParams.get("since");
  if (sinceCursor(current) && nextValue !== null) {
    const previous = current.searchParams.get("since") ?? "0";
    return (
      /^\d+$/u.test(previous) && /^\d+$/u.test(nextValue) && BigInt(nextValue) > BigInt(previous)
    );
  }
  const page = Number(next.searchParams.get("page"));
  const previous = Number(current.searchParams.get("page") ?? 1);
  if (next.searchParams.has("page")) return Number.isSafeInteger(page) && page > previous;
  return [...paginationKeys].some(
    (key) =>
      next.searchParams.has(key) && next.searchParams.get(key) !== current.searchParams.get(key),
  );
}

/** Session-owned universal Read resources and unrestricted selected-connection REST/GraphQL writes. */
export class GithubApiResources {
  readonly #results = new Map<string, ApiSnapshot>();
  #storedBytes = 0;
  #generation = 0;
  constructor(readonly client: (cwd: string) => Promise<GithubApiClient>) {}

  /** Raw Write entry points; the caller's agent remains responsible for authorizing destructive work. */
  ownsAction(source: string): boolean {
    return source === restSource || source === graphqlSource;
  }

  /** Preserve recovery identity only for an actual response retained by this provider instance. */
  failureResponse(
    error: unknown,
  ): { source: string; code: string; effect: "not-applied" | "applied" | "unknown" } | undefined {
    if (!(error instanceof ResourceError) || !this.#results.has(error.source)) return undefined;
    return { source: error.source, code: error.code, effect: error.effect };
  }
  /** Retire in-flight responses too, so a cleared connection cannot refill this cache. */
  clear(): void {
    this.#generation++;
    this.#results.clear();
    this.#storedBytes = 0;
  }

  async #next(
    route: string,
    raw: string | undefined,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!raw) return undefined;
    const current = new URL(githubApiUrl(route));
    const next = new URL(githubApiUrl(raw));
    if (current.pathname !== next.pathname) {
      const slug = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/u.exec(current.pathname);
      const numeric = /^\/repositories\/(\d+)(\/.*)?$/u.exec(next.pathname);
      if (!slug || !numeric || slug.at(3) !== numeric.at(2)) fail("GH_INVALID_PAGINATION", route);
      const { data } = await (
        await this.client(cwd)
      ).rest("GET", `/repos/${slug[1]}/${slug[2]}`, undefined, signal);
      if (
        data === null ||
        typeof data !== "object" ||
        !("id" in data) ||
        String(data.id) !== numeric[1] ||
        !("full_name" in data) ||
        typeof data.full_name !== "string" ||
        data.full_name.toLowerCase() !== `${slug[1]}/${slug[2]}`.toLowerCase()
      )
        fail("GH_INVALID_PAGINATION", route);
      next.pathname = current.pathname;
    }
    if (filters(current) !== filters(next) || !samePage(current, next))
      fail("GH_INVALID_PAGINATION", route);
    return next.href;
  }

  async #request(
    method: string,
    route: string,
    body: unknown,
    cwd: string,
    signal?: AbortSignal,
    accept?: string,
  ): Promise<ApiResponse> {
    githubApiUrl(route);
    try {
      return await (
        await this.client(cwd)
      ).request(method, route, body, signal, accept ? { accept } : undefined);
    } catch (error) {
      if (error instanceof GithubApiError)
        throw githubResourceError(error, route, "GH_REQUEST_FAILED");
      throw error;
    }
  }

  #remember(request: string, response: ApiResponse, next?: string): ApiSnapshot {
    const source = resultPrefix + randomUUID();
    const snapshot: ApiSnapshot = {
      source,
      request,
      response: { ...response, bytes: Uint8Array.from(response.bytes) },
      ...(next ? { next } : {}),
    };
    this.#results.set(source, snapshot);
    this.#storedBytes += snapshot.response.bytes.byteLength;
    while (this.#results.size > maximumResults || this.#storedBytes > maximumStoredBytes) {
      const oldest = this.#results.entries().next();
      if (oldest.done) break;
      const [key, stale] = oldest.value;
      this.#storedBytes -= stale.response.bytes.byteLength;
      this.#results.delete(key);
    }
    return snapshot;
  }

  /** Complete one arbitrary request and expose its exact response as a separate readonly resource. */
  async perform(
    source: string,
    content: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GithubApiReceipt> {
    if (!this.ownsAction(source)) fail("GH_UNSUPPORTED_RESOURCE", source);
    const value = input(source, content, source === restSource ? restSchema : graphqlSchema);
    const graphql = source === graphqlSource;
    const method = graphql ? "POST" : String(value.method);
    const route = graphql ? "/graphql" : String(value.path);
    const body = graphql ? value : value.body;
    const generation = this.#generation;
    const assertCurrent = () => {
      if (generation !== this.#generation)
        fail(
          "GH_RESULT_EXPIRED",
          source,
          method === "GET" || method === "HEAD" ? "not-applied" : "unknown",
        );
    };
    const response = await this.#request(
      method,
      route,
      body,
      cwd,
      signal,
      value.accept as string | undefined,
    );
    assertCurrent();
    let snapshot = this.#remember(`${method} ${githubApiUrl(route)}`, response);
    const next = await this.#next(route, response.next, cwd, signal).catch((error) => {
      const code = error instanceof ResourceError ? error.code : "GH_INVALID_PAGINATION";
      fail(
        code,
        snapshot.source,
        method === "GET" || method === "HEAD" ? "not-applied" : "unknown",
      );
    });
    assertCurrent();
    if (next) {
      snapshot = { ...snapshot, next };
      this.#results.set(snapshot.source, snapshot);
    }
    const endpoint = new URL(githubApiUrl(route));
    if (endpoint.pathname === "/graphql" && ["GET", "POST"].includes(method)) {
      const decoded = responseText(response);
      const data = decoded.data as { errors?: unknown; data?: unknown } | undefined;
      const document =
        body && typeof body === "object" && "query" in body
          ? body.query
          : endpoint.searchParams.get("query");
      const readonly =
        typeof document === "string" && !!document.trim() && !/\bmutation\b/u.test(document);
      const effect = readonly ? "not-applied" : "unknown";
      if (!data || typeof data !== "object" || Array.isArray(data))
        fail("GH_INVALID_RESPONSE", snapshot.source, effect);
      if (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length > 0))
        fail("GH_GRAPHQL_ERROR", snapshot.source, effect);
      if (data.data === undefined || data.data === null)
        fail("GH_INVALID_RESPONSE", snapshot.source, effect);
    }
    return { source: snapshot.source, status: response.status, effect: "applied" };
  }

  async #load(source: string, cwd: string, signal?: AbortSignal): Promise<ApiSnapshot | undefined> {
    signal?.throwIfAborted();
    if (source.startsWith(resultPrefix)) {
      if (!/^github:\/\/api\/results\/[a-f0-9-]{36}$/u.test(source)) fail("GH_INVALID_URI", source);
      const snapshot = this.#results.get(source);
      if (!snapshot) fail("GH_RESULT_EXPIRED", source);
      return snapshot;
    }
    if (!source.startsWith(`${apiOrigin}/`)) return undefined;
    if (new URL(githubApiUrl(source)).pathname === "/graphql")
      fail("GH_GRAPHQL_WRITE_REQUIRED", source);
    const route = githubApiUrl(source);
    const response = await this.#request("GET", route, undefined, cwd, signal);
    const next = await this.#next(route, response.next, cwd, signal);
    return { source: route, request: `GET ${route}`, response, ...(next ? { next } : {}) };
  }

  /** Read schemas or one response; links are displayed, never followed implicitly. */
  async readText(
    source: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ source: string; content: string; complete?: boolean } | undefined> {
    if (source === "github://api")
      return {
        source,
        content:
          "# GitHub API: choose a resource\n\nRead: https://api.github.com/installation/repositories\nREST request schema: github://api/rest\nGraphQL request schema: github://api/graphql\nRate limits: https://api.github.com/rate_limit\nGuide: docs:github-api\nResource families: docs:github-coverage\n",
      };
    if (this.ownsAction(source))
      return {
        source,
        content: JSON.stringify(
          {
            source,
            tool: "write",
            mode: "YOLO",
            notice:
              "Arbitrary GitHub API calls have no per-request confirmation. Typed route gates can be bypassed. Ask the user before destructive work.",
            input: source === restSource ? restSchema : graphqlSchema,
          },
          null,
          2,
        ),
      };
    const snapshot = await this.#load(source, cwd, signal);
    return snapshot
      ? {
          source: snapshot.source,
          content: render(snapshot),
          ...(snapshot.next ? { complete: false } : {}),
        }
      : undefined;
  }

  /** Register readonly API text and original-byte windows on the public resource protocol. */
  resolver(): ResourceResolver {
    return {
      id: "github-api",
      tryResolve: async (source, context) => {
        if (!isGithubApiResource(source)) return { kind: "not-handled" };
        try {
          if (source === "github://api" || this.ownsAction(source)) {
            const schema = await this.readText(source, context.cwd, context.signal);
            if (!schema) fail("GH_UNSUPPORTED_RESOURCE", source);
            return {
              kind: "resolved",
              resource: { source, read: async () => [{ type: "text", text: schema.content }] },
            };
          }
          const snapshot = await this.#load(source, context.cwd, context.signal);
          const load = async (signal?: AbortSignal) => {
            signal?.throwIfAborted();
            return snapshot;
          };
          return {
            kind: "resolved",
            resource: {
              source,
              read: async (operation) => {
                const snapshot = await load(operation.signal);
                if (!snapshot) fail("GH_UNSUPPORTED_RESOURCE", source);
                return [{ type: "text", text: render(snapshot) }];
              },
              readBytes: async (offset, limit, operation) => {
                const snapshot = await load(operation.signal);
                if (!snapshot) fail("GH_UNSUPPORTED_RESOURCE", source);
                const bytes = snapshot.response.bytes;
                const start = Math.min(
                  bytes.length,
                  Math.max(0, offset < 0 ? bytes.length + offset : offset),
                );
                return {
                  bytes: Uint8Array.from(bytes.subarray(start, start + (limit ?? bytes.length))),
                  byteOffset: start,
                  totalBytes: bytes.length,
                };
              },
            },
          };
        } catch (error) {
          return {
            kind: "failed",
            error: githubResourceError(error, source, "GH_API_RESOLVE_FAILED"),
          };
        }
      },
    };
  }
}
