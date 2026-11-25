import { ResourceError, type ResourceResolver } from "pi-agent-ide/api/resource";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { linearResourceError } from "./resource-failure.ts";
import { linearJsonContent, withLinearJson, type LinearJsonSnapshot } from "./json-read.ts";
import {
  createLinearOperationBackend,
  type LinearOperationBackend,
  type LinearOperationCapability,
} from "./operation-backend.ts";
import { linearOperationRoute, type LinearOperationRoute } from "./operation-routes.ts";

interface DomainAddress {
  readonly workspace: string;
  readonly kind: string;
  readonly id?: string;
  readonly source: string;
  readonly parameters: ReadonlyMap<string, string>;
}
const pageSize = 50;
const listKinds: Readonly<Record<string, string>> = {
  customers: "customer",
  "customer-requests": "customer-request",
  issues: "issue",
  projects: "project",
  documents: "document",
  comments: "comment",
  teams: "team",
  users: "user",
  statuses: "status",
  labels: "label",
  "project-labels": "project-label",
  cycles: "cycle",
  milestones: "milestone",
  views: "view",
  releases: "release",
  "release-notes": "release-note",
  "release-pipelines": "release-pipeline",
  "status-updates": "status-update",
  notifications: "notification",
  "agent-skills": "agent-skill",
  "workflow-skills": "workflow-skill",
  templates: "template",
  diffs: "diff",
};
const payloadKeys: Readonly<Record<string, readonly string[]>> = {
  "customer-requests": ["customerNeeds"],
  "project-labels": ["projectLabels", "labels"],
  views: ["customViews", "views"],
  "release-notes": ["releaseNotes"],
  "release-pipelines": ["releasePipelines", "pipelines"],
  "status-updates": ["statusUpdates", "updates"],
  "agent-skills": ["agentSkills", "skills"],
  "workflow-skills": ["agentSkills", "skills"],
};
function fail(code: string, source: string, rateLimit?: unknown): never {
  throw linearResourceError(code, source, "not-applied", rateLimit);
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function routeFor(kind: string): LinearOperationRoute | undefined {
  return (
    linearOperationRoute(kind, "read") ??
    linearOperationRoute(
      Object.keys(listKinds).find((key) => listKinds[key] === kind) ?? "",
      "read",
    )
  );
}
function addressFor(source: string): DomainAddress | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.protocol !== "linear:") return undefined;
  const rawParts = url.pathname.split("/").filter(Boolean);
  if (rawParts.length > 2) return undefined;
  if (!rawParts.length) rawParts.push("workspace");
  let parts: string[];
  try {
    parts = rawParts.map(decodeURIComponent);
  } catch {
    fail("LINEAR_INVALID_URL", source);
  }
  const kind = parts[0];
  const id = parts.at(1);
  if (!routeFor(kind) || url.hash || (kind === "document" && id && !url.search)) return undefined;
  if (
    url.username ||
    url.password ||
    url.port ||
    !/^[A-Za-z0-9_-]+$/u.test(url.hostname) ||
    id === "new" ||
    (id !== undefined && !id.trim())
  )
    fail("LINEAR_INVALID_URL", source);
  const parameters = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (
      parameters.has(key) ||
      !/^[A-Za-z][A-Za-z0-9]*$/u.test(key) ||
      value.length > 4096 ||
      /[\r\n]/u.test(value)
    )
      fail("LINEAR_INVALID_OPERATION_INPUT", source);
    parameters.set(key, value);
  }
  return { workspace: url.hostname, kind, ...(id ? { id } : {}), source: url.href, parameters };
}
function properties(
  capability: LinearOperationCapability,
  source: string,
): Record<string, unknown> {
  const value = record(capability.inputSchema.properties);
  if (capability.inputSchema.type !== "object" || !value) fail("LINEAR_SCHEMA_INVALID", source);
  return value;
}
function displayTitle(row: Record<string, unknown>, fallback: string): string {
  return typeof row.title === "string"
    ? row.title
    : typeof row.name === "string"
      ? row.name
      : fallback;
}
function acceptsRecord(schema: unknown, value: unknown): boolean {
  const properties = record(schema);
  return properties !== undefined && accepts(properties, value);
}
function accepts(schema: Record<string, unknown>, value: unknown): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.const !== undefined && schema.const !== value) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((item) => acceptsRecord(item, value)))
    return false;
  if (
    Array.isArray(schema.oneOf) &&
    schema.oneOf.filter((item) => acceptsRecord(item, value)).length !== 1
  )
    return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every((item) => acceptsRecord(item, value)))
    return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (
    types.length &&
    !types.some((type) => {
      if (type === "null") return value === null;
      if (type === "string") return typeof value === "string";
      if (type === "boolean") return typeof value === "boolean";
      if (type === "number") return typeof value === "number" && Number.isFinite(value);
      if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
      if (type === "array") return Array.isArray(value);
      if (type === "object") return !!record(value);
      return false;
    })
  )
    return false;
  if (
    typeof value === "number" &&
    ((typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum))
  )
    return false;
  if (
    typeof value === "string" &&
    ((typeof schema.minLength === "number" && value.length < schema.minLength) ||
      (typeof schema.maxLength === "number" && value.length > schema.maxLength))
  )
    return false;
  const itemSchema = record(schema.items);
  if (Array.isArray(value) && itemSchema && !value.every((item) => accepts(itemSchema, item)))
    return false;
  return true;
}
function parsedValue(text: string, schema: Record<string, unknown>, source: string): unknown {
  if (schema.type === "string") {
    if (accepts(schema, text)) return text;
    fail("LINEAR_INVALID_OPERATION_INPUT", source);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  if (!accepts(schema, value)) fail("LINEAR_INVALID_OPERATION_INPUT", source);
  return value;
}
function operationInput(
  address: DomainAddress,
  route: LinearOperationRoute,
  capability: LinearOperationCapability,
): Record<string, unknown> {
  const fields = properties(capability, address.source);
  const input: Record<string, unknown> = {};
  for (const [key, text] of address.parameters) {
    const schema = record(fields[key]);
    if (!schema) fail("LINEAR_INVALID_OPERATION_INPUT", address.source);
    if (route.identity && address.id && key === route.identity)
      fail("LINEAR_IDENTITY_OVERRIDE", address.source);
    input[key] = parsedValue(text, schema, address.source);
  }
  if (route.identity) {
    if (!address.id) fail("LINEAR_IDENTITY_REQUIRED", address.source);
    input[route.identity] = address.id;
  }
  const limitSchema = record(fields.limit);
  if (limitSchema) {
    if (input.limit === undefined) {
      const maximum = limitSchema.maximum;
      input.limit = typeof maximum === "number" ? Math.min(pageSize, maximum) : pageSize;
    }
    if (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > pageSize)
      fail("LINEAR_PAGE_LIMIT_EXCEEDED", address.source);
  }
  if (typeof input.cursor === "string" && (!input.cursor || input.cursor.length > 1024))
    fail("LINEAR_INVALID_OPERATION_INPUT", address.source);
  for (const key of Array.isArray(capability.inputSchema.required)
    ? capability.inputSchema.required
    : []) {
    if (typeof key !== "string" || !Object.hasOwn(input, key) || input[key] === "")
      fail("LINEAR_OPERATION_INPUT_REQUIRED", address.source);
  }
  for (const [key, value] of Object.entries(input)) {
    const schema = record(fields[key]);
    if (!schema || !accepts(schema, value)) fail("LINEAR_INVALID_OPERATION_INPUT", address.source);
  }
  return input;
}
function checkedWorkspace(row: Record<string, unknown>, address: DomainAddress): void {
  if (typeof row.url === "string") {
    let url: URL;
    try {
      url = new URL(row.url);
    } catch {
      fail("LINEAR_INVALID_RESPONSE", address.source);
    }
    if (
      url.hostname === "linear.app" &&
      (url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname.split("/")[1] !== address.workspace)
    )
      fail("LINEAR_IDENTITY_MISMATCH", address.source);
  }
  if (typeof row.workspace === "string" && row.workspace !== address.workspace)
    fail("LINEAR_IDENTITY_MISMATCH", address.source);
}
function sameIdentity(row: Record<string, unknown>, id: string): boolean {
  const identities = [row.id, row.uuid, row.identifier, row.key, row.slug, row.name, row.url];
  if (identities.includes(id)) return true;
  if (typeof row.url === "string") {
    try {
      const parts = new URL(row.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
      return parts.includes(id);
    } catch {
      return false;
    }
  }
  return false;
}
interface Page {
  readonly items: readonly unknown[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly hasNextPage?: boolean;
  readonly cursor?: string;
  readonly totalCount?: number;
}
function collection(data: unknown, address: DomainAddress, route: LinearOperationRoute): Page {
  let value: unknown = data;
  let metadata = record(data) ?? {};
  if (!Array.isArray(data)) {
    const keys = [...(payloadKeys[route.kind] ?? [route.kind]), "nodes", "items"];
    const key = keys.find((key) => Array.isArray(metadata[key]) || !!record(metadata[key]));
    if (!key) fail("LINEAR_INVALID_RESPONSE", address.source);
    value = metadata[key];
    if (record(value)) {
      metadata = { ...metadata, ...record(value) };
      value = metadata.nodes ?? metadata.items ?? metadata[route.kind];
    }
  }
  if (!Array.isArray(value)) fail("LINEAR_INVALID_RESPONSE", address.source);
  if (value.length > pageSize) fail("LINEAR_PAGE_LIMIT_EXCEEDED", address.source);
  const info = record(metadata.pageInfo);
  const hasNextPage = info?.hasNextPage ?? metadata.hasNextPage;
  if (hasNextPage !== undefined && typeof hasNextPage !== "boolean")
    fail("LINEAR_PAGINATION_UNVERIFIED", address.source);
  const cursor = info?.endCursor ?? metadata.cursor ?? metadata.nextCursor;
  if (
    hasNextPage === true &&
    (typeof cursor !== "string" || !cursor || cursor.length > 1024 || /[\r\n]/u.test(cursor))
  )
    fail("LINEAR_PAGINATION_UNVERIFIED", address.source);
  if (hasNextPage === undefined && cursor) fail("LINEAR_PAGINATION_UNVERIFIED", address.source);
  const totalCount = metadata.totalCount;
  if (totalCount !== undefined && (!Number.isSafeInteger(totalCount) || Number(totalCount) < 0))
    fail("LINEAR_INVALID_RESPONSE", address.source);
  return {
    items: value,
    metadata,
    ...(typeof hasNextPage === "boolean" ? { hasNextPage } : {}),
    ...(hasNextPage === true ? { cursor: cursor as string } : {}),
    ...(typeof totalCount === "number" ? { totalCount } : {}),
  };
}
function itemAddress(
  row: Record<string, unknown>,
  address: DomainAddress,
  route: LinearOperationRoute,
  available: readonly LinearOperationCapability[],
  input: Record<string, unknown>,
): string | undefined {
  const kind = listKinds[route.kind];
  const identity = row.id ?? row.uuid ?? row.identifier;
  if (!kind || typeof identity !== "string" || !identity) return undefined;
  const getter = routeFor(kind);
  const cap = getter && available.find((item) => item.name === getter.operation);
  if (!cap) return undefined;
  const url = new URL(`linear://${address.workspace}/${kind}/${encodeURIComponent(identity)}`);
  const fields = properties(cap, address.source);
  for (const [key, value] of Object.entries(input)) {
    if (
      key === getter.identity ||
      key === "cursor" ||
      key === "limit" ||
      !Object.hasOwn(fields, key)
    )
      continue;
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  if (kind === "status" && typeof row.name === "string") url.searchParams.set("name", row.name);
  if (kind === "customer-request") {
    const project = record(row.project)?.id;
    if (typeof project !== "string") fail("LINEAR_IDENTITY_MISMATCH", address.source);
    url.searchParams.set("project", project);
  }
  return url.href;
}
function actionLinks(address: DomainAddress): string[] {
  const base = address.source.split("#")[0];
  return [`Schema: ${base}#schema`, `Actions: ${base}#actions`];
}
async function readDomain(
  address: DomainAddress,
  cwd: string,
  signal: AbortSignal | undefined,
  backend: LinearOperationBackend,
): Promise<LinearJsonSnapshot> {
  signal?.throwIfAborted();
  const available = await backend.capabilities(address.workspace, cwd, signal);
  const route = routeFor(address.kind);
  const cap = route && available.find((item) => item.name === route.operation);
  if (!route || !cap) fail("LINEAR_OPERATION_UNAVAILABLE", address.source);
  const input = operationInput(address, route, cap);
  const receipt = await backend.invoke(address.workspace, route.operation, input, cwd, signal);
  if (receipt.workspace !== address.workspace || receipt.operation !== route.operation)
    fail("LINEAR_IDENTITY_MISMATCH", address.source);
  if (receipt.error || receipt.effect !== "applied")
    fail(receipt.error ?? "LINEAR_RESOURCE_READ_FAILED", address.source, receipt.rateLimit);
  const isList = Object.hasOwn(listKinds, route.kind);
  if (isList) {
    const page = collection(receipt.data, address, route);
    for (const item of page.items) {
      const row = record(item);
      if (row) checkedWorkspace(row, address);
    }
    const id = address.id;
    if (id) {
      const match = page.items.map(record).find((row) => row && sameIdentity(row, id));
      if (!match)
        fail(
          page.hasNextPage === true || page.hasNextPage === undefined
            ? "LINEAR_LOOKUP_INCOMPLETE"
            : "LINEAR_NOT_FOUND",
          address.source,
        );
      return withLinearJson(
        {
          content: [
            `# ${displayTitle(match, address.kind)}`,
            `URL: ${address.source}`,
            ...actionLinks(address),
            "",
            JSON.stringify(match, null, 2),
          ].join("\n"),
        },
        match,
      );
    }
    const lines = [
      `# Linear ${address.kind}`,
      `URL: ${address.source}`,
      ...actionLinks(address),
      `Returned: ${page.items.length}`,
      ...(page.totalCount === undefined ? [] : [`Total reported: ${page.totalCount}`]),
      "",
    ];
    for (const item of page.items) {
      const row = record(item);
      if (!row) continue;
      const link = itemAddress(row, address, route, available, input);
      if (link) lines.push(`${String(row.title ?? row.name ?? row.identifier ?? row.id)}: ${link}`);
    }
    let coverage: string;
    if (page.hasNextPage === true) {
      if (!record(properties(cap, address.source).cursor))
        fail("LINEAR_PAGINATION_UNVERIFIED", address.source);
      const next = new URL(address.source);
      if (typeof input.limit === "number") next.searchParams.set("limit", String(input.limit));
      if (page.cursor === undefined) fail("LINEAR_PAGINATION_UNVERIFIED", address.source);
      next.searchParams.set("cursor", page.cursor);
      coverage = `Next page: ${next.href}\nCoverage: this page only.`;
      lines.push("", `Next page: ${next.href}`, "Coverage: this page only.");
    } else {
      coverage =
        page.hasNextPage === false
          ? "End of API list."
          : "Pagination: not reported by API; completeness is not confirmed.";
      lines.push("", coverage);
    }
    // Preserve the returned page and nested metadata without fetching another resource.
    lines.push("", JSON.stringify(receipt.data, null, 2));
    return withLinearJson({ content: lines.join("\n") }, receipt.data, coverage);
  }
  const root = record(receipt.data);
  if (!root) fail("LINEAR_INVALID_RESPONSE", address.source);
  const aliases = [
    address.kind,
    address.kind.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
  ];
  const row = aliases.map((key) => record(root[key])).find(Boolean) ?? root;
  checkedWorkspace(row, address);
  if (address.kind === "workspace" && row.url !== `https://linear.app/${address.workspace}`)
    fail("LINEAR_IDENTITY_MISMATCH", address.source);
  if (address.id && !sameIdentity(row, address.id))
    fail("LINEAR_IDENTITY_MISMATCH", address.source);
  return withLinearJson(
    {
      content: [
        `# ${displayTitle(row, address.kind)}`,
        `URL: ${address.source}`,
        ...actionLinks(address),
        "",
        JSON.stringify(receipt.data, null, 2),
      ].join("\n"),
    },
    receipt.data,
  );
}

/** Explain a missing milestone parent after shared Read sanitizes provider errors. */
export function connectLinearDomainReadRecovery(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read" || !event.isError) return;
    const cause = record(record(event.details)?.failure)?.cause;
    if (!(cause instanceof ResourceError) || cause.code !== "LINEAR_OPERATION_INPUT_REQUIRED")
      return;
    const address = addressFor(cause.source);
    if (address?.kind !== "milestone" || address.parameters.get("project")) return;
    const action = address.parameters.has("project")
      ? "Set project=<value> in the URL query."
      : `Add ${address.parameters.size ? "&" : "?"}project=<value> to the URL.`;
    const hint = `Missing required query parameter "project". ${action} Read ${address.source}#schema for the input schema.`;
    const structured = record(event.structuredContent);
    return {
      content: [...event.content, { type: "text" as const, text: hint }],
      ...(structured && Array.isArray(structured.errors)
        ? {
            structuredContent: {
              ...structured,
              errors: structured.errors.map((error: unknown) => {
                const item = record(error);
                return {
                  ...item,
                  message: `${typeof item?.message === "string" ? item.message : cause.code}\n${hint}`,
                };
              }),
            },
          }
        : {}),
    };
  });
}
/** Read one explicit domain card or API list; query parameters follow its advertised schema. */
export async function readLinearDomain(
  source: string,
  cwd: string,
  signal?: AbortSignal,
  backend: LinearOperationBackend = createLinearOperationBackend(),
): Promise<string> {
  const address = addressFor(source);
  if (!address) fail("LINEAR_INVALID_URL", source);
  return (await readDomain(address, cwd, signal, backend)).content;
}

/** Add read-only stable domain routes without taking native cards, bodies or result scopes. */
export function createLinearDomainResolver(
  backend: LinearOperationBackend = createLinearOperationBackend(),
): ResourceResolver {
  return {
    id: "linear-domain",
    async tryResolve(source, context) {
      let address: DomainAddress | undefined;
      try {
        address = addressFor(source);
      } catch (error) {
        return { kind: "failed", error: error as Error };
      }
      if (!address) return { kind: "not-handled" };
      return {
        kind: "resolved",
        resource: {
          source: address.source,
          link: address.source,
          async read(operation) {
            return linearJsonContent(
              await readDomain(address, context.cwd, operation.signal ?? context.signal, backend),
            );
          },
        },
      };
    },
  };
}
