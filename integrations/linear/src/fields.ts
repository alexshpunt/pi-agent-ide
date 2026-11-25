import { isDeepStrictEqual } from "node:util";
import { ResourceError, type ResourceResolver } from "pi-agent-ide/api/resource";
import type {
  LinearOperationBackend,
  LinearOperationCapability,
  LinearOperationReceipt,
} from "./operation-backend.ts";
import {
  LINEAR_OPERATION_ROUTES,
  linearOperationRoute,
  type LinearOperationRoute,
} from "./operation-routes.ts";
import { isDocumentId } from "./urls.ts";
import { linearResourceError } from "./resource-failure.ts";
import {
  linearApiPageCoverage,
  linearJsonContent,
  linearJsonSnapshot,
  type LinearJsonSnapshot,
} from "./json-read.ts";

/** What a resolved field resource already fetched, so its write does not fetch it again. */
interface FetchedState {
  available?: readonly LinearOperationCapability[];
  row?: Record<string, unknown>;
}

export interface LinearFieldAddress {
  readonly workspace: string;
  readonly kind: string;
  readonly id?: string;
  readonly facet?: string;
  readonly source: string;
  readonly parameters: Readonly<Record<string, string>>;
}
const kinds = new Set([
  ...LINEAR_OPERATION_ROUTES.map((route) => route.kind),
  "cycle",
  "view",
  "release-pipeline",
]);

/** Preserve object identity and field fragments instead of treating them as browser anchors. */
export function parseLinearFieldAddress(source: string): LinearFieldAddress | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.protocol !== "linear:" && !(url.protocol === "https:" && url.hostname === "linear.app"))
    return undefined;
  if (url.username || url.password || url.port) throw new Error("LINEAR_INVALID_URL");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const native = url.protocol === "https:";
  const workspace = native ? parts.shift() : url.hostname;
  if (
    !workspace ||
    !/^[A-Za-z0-9_-]+$/u.test(workspace) ||
    ["docs", "developers", "oauth", "settings", "login"].includes(workspace)
  )
    return undefined;
  const kind = parts.shift();
  if (!kind || !kinds.has(kind)) return undefined;
  const id = parts.shift();
  if (
    (!native && parts.length) ||
    (native && parts.length > (kind === "issue" || kind === "project" ? 1 : 0))
  )
    return undefined;
  const facet = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;
  if (facet && !/^[a-zA-Z][a-zA-Z0-9-]*$/u.test(facet)) return undefined;
  const parameters: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(parameters, key) || !/^[a-zA-Z][a-zA-Z0-9]*$/u.test(key))
      throw new Error("LINEAR_INVALID_URL");
    parameters[key] = value;
  }
  return {
    workspace,
    kind,
    ...(id ? { id } : {}),
    ...(facet ? { facet } : {}),
    source: url.href,
    parameters,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LINEAR_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function fail(
  code: string,
  source: string,
  effect: "not-applied" | "applied" | "unknown" = "not-applied",
  rateLimit?: unknown,
): never {
  throw linearResourceError(code, source, effect, rateLimit);
}
function property(
  schema: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> | undefined {
  const properties = schema.properties;
  return properties &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Object.hasOwn(properties, field)
    ? object((properties as Record<string, unknown>)[field])
    : undefined;
}
function accepts(schema: Record<string, unknown>, value: unknown): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  for (const union of [schema.anyOf, schema.oneOf])
    if (Array.isArray(union)) return union.some((branch) => accepts(object(branch), value));
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types[0] === undefined) return true;
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "string") return typeof value === "string";
    if (type === "boolean") return typeof value === "boolean";
    if (type === "integer") return Number.isSafeInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "array")
      return (
        Array.isArray(value) &&
        (!schema.items || value.every((item) => accepts(object(schema.items), item)))
      );
    if (type === "object")
      return value !== null && typeof value === "object" && !Array.isArray(value);
    return false;
  });
}
function parseValue(text: string, schema: Record<string, unknown>): unknown {
  if (schema.type === "array" && !text.trimStart().startsWith("[")) {
    if (object(schema.items).type !== "string") throw new Error("LINEAR_INVALID_FIELD_VALUE");
    return [
      ...new Set(
        text
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ];
  }
  if (schema.type === "string") return text.replace(/\r?\n$/u, "");
  try {
    const value: unknown = JSON.parse(text);
    if (accepts(schema, value)) return value;
  } catch {
    /* A string in a nullable/union field may be unquoted. */
  }
  if (accepts(schema, text.trim())) return text.trim();
  throw new Error("LINEAR_INVALID_FIELD_VALUE");
}
function display(value: unknown): string {
  if (value === undefined) throw new Error("LINEAR_FIELD_NOT_EXPOSED");
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value.length ? value.join("\n") : "[]";
  return JSON.stringify(value, null, 2);
}
function valueFromCard(card: Record<string, unknown>, field: string): unknown {
  if (field === "descriptionData" && typeof card.templateData === "string")
    return object(JSON.parse(card.templateData)).descriptionData;
  const value = card[field === "state" ? "status" : field];
  if (field === "priority" && value && typeof value === "object" && !Array.isArray(value))
    return (value as Record<string, unknown>).value;
  if (field === "state" && value && typeof value === "object" && !Array.isArray(value))
    return (value as Record<string, unknown>).name;
  if (field === "assignee" || field === "delegate") {
    if (value === undefined)
      return field === "assignee" ? (card.assigneeId ?? null) : card.delegateId;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const assignee = value as Record<string, unknown>;
      return assignee.name ?? assignee.id;
    }
  }
  if (field === "estimate" && value && typeof value === "object" && !Array.isArray(value))
    return (value as Record<string, unknown>).value;
  if (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).name === "string",
    )
  )
    return value.map((item) => (item as Record<string, unknown>).name);
  return value;
}
// Read relations independently of the string-valued mutation input schema.
function issueMilestoneFromCard(card: Record<string, unknown>): unknown {
  const mcp = Object.hasOwn(card, "milestone");
  const value = mcp
    ? card.milestone
    : Object.hasOwn(card, "projectMilestone")
      ? card.projectMilestone
      : undefined;
  if (value === undefined) throw new Error("LINEAR_FIELD_NOT_EXPOSED");
  if (value === null) return null;
  if (mcp && typeof value === "string" && value.trim()) return value;
  const milestone = object(value);
  if (
    typeof milestone.id !== "string" ||
    !milestone.id.trim() ||
    (Object.hasOwn(milestone, "name") && typeof milestone.name !== "string")
  )
    throw new Error("LINEAR_INVALID_RESPONSE");
  return milestone;
}
function isCreation(address: LinearFieldAddress): boolean {
  return address.id === "new" || address.facet === "new";
}
function editableCard(
  card: Record<string, unknown>,
  cap: LinearOperationCapability,
  identity?: string,
): Record<string, unknown> {
  const properties = object(cap.inputSchema.properties ?? {});
  return Object.fromEntries(
    Object.keys(properties)
      .filter(
        (key) =>
          key !== identity &&
          key !== "patch" &&
          !(cap.name === "save_document" && key === "title") &&
          valueFromCard(card, key) !== undefined,
      )
      .map((key) => [key, valueFromCard(card, key)]),
  );
}
function fieldRequestable(cap: LinearOperationCapability, field: string): boolean {
  const items = property(cap.inputSchema, "fields")?.items;
  const values =
    items && typeof items === "object" ? (items as Record<string, unknown>).enum : undefined;
  return Array.isArray(values) && values.includes(field === "state" ? "status" : field);
}
function fieldName(address: LinearFieldAddress): string | undefined {
  if (!address.facet || ["fields", "actions", "schema"].includes(address.facet)) return undefined;
  return address.facet === "status" ? "state" : address.facet;
}

function creationRoute(
  kind: string,
  available: readonly LinearOperationCapability[],
): LinearOperationRoute | undefined {
  const save = linearOperationRoute(kind, "write");
  const create = linearOperationRoute(kind, "write", "new");
  return save?.allowsCreation === false &&
    create &&
    available.some((item) => item.name === create.operation)
    ? create
    : save;
}
/** Typed fields and explicit domain actions over the backend's fixed operation catalog. */
export function createLinearFields(
  backend: LinearOperationBackend,
  requirePermit?: (source: string, content: string) => void,
) {
  async function capabilities(address: LinearFieldAddress, cwd: string, signal?: AbortSignal) {
    return backend.capabilities(address.workspace, cwd, signal);
  }
  function capability(
    available: readonly LinearOperationCapability[],
    route: LinearOperationRoute | undefined,
    source: string,
  ): LinearOperationCapability {
    const result = route && available.find((item) => item.name === route.operation);
    if (!result) fail("LINEAR_OPERATION_UNAVAILABLE", source);
    return result;
  }
  function resourceInputSchema(
    available: readonly LinearOperationCapability[],
    route: LinearOperationRoute | undefined,
    source: string,
  ): Readonly<Record<string, unknown>> {
    const schema = capability(available, route, source).inputSchema;
    if (!route?.identity || route.mode === "read") return schema;
    // Ordinary mutation tools bind identity from the URL and reject payload overrides.
    return {
      ...schema,
      ...(schema.properties
        ? {
            properties: Object.fromEntries(
              Object.entries(object(schema.properties)).filter(([key]) => key !== route.identity),
            ),
          }
        : {}),
      ...(Array.isArray(schema.required)
        ? { required: schema.required.filter((key) => key !== route.identity) }
        : {}),
    };
  }
  async function invoke(
    address: LinearFieldAddress,
    operation: string,
    input: Record<string, unknown>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<LinearOperationReceipt> {
    const result = await backend.invoke(address.workspace, operation, input, cwd, signal);
    if (result.effect !== "applied" || result.error) {
      let source = address.source;
      // Retain the native correlation resource when creation dispatch is uncertain.
      if (
        result.effect === "unknown" &&
        ["workflow-skill", "workflow-template"].includes(address.kind) &&
        isCreation(address)
      ) {
        const id = result.targetId;
        if (typeof id === "string" && isDocumentId(id))
          source = `linear://${address.workspace}/${address.kind}/${id}`;
      }
      fail(result.error ?? "LINEAR_OPERATION_FAILED", source, result.effect, result.rateLimit);
    }
    return result;
  }
  function parameters(
    address: LinearFieldAddress,
    cap: LinearOperationCapability,
  ): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(address.parameters)) {
      const schema = property(cap.inputSchema, key);
      if (!schema) fail("LINEAR_INVALID_OPERATION_INPUT", address.source);
      input[key] = parseValue(value, schema);
    }
    return input;
  }
  async function prepareIssueInput(
    address: LinearFieldAddress,
    available: readonly LinearOperationCapability[],
    input: Record<string, unknown>,
    before: Record<string, unknown> | undefined,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (typeof input.assignee === "string") {
      let id = input.assignee;
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)) {
        const cap = capability(available, linearOperationRoute("user", "read"), address.source);
        const result = await invoke(address, cap.name, { query: id }, cwd, signal);
        const root = object(result.data);
        const user = root.user ? object(root.user) : root;
        if (typeof user.id !== "string" || !user.id)
          fail("LINEAR_INVALID_RESPONSE", address.source);
        id = user.id;
      }
      input.assignee = id;
    }
    const labelFields = ["labels", "addLabels", "removeLabels"].filter((key) =>
      Object.hasOwn(input, key),
    );
    if (!labelFields.length) return;
    if (labelFields.includes("labels") && labelFields.length > 1)
      fail("LINEAR_INVALID_FIELD_VALUE", address.source);
    const values = labelFields.flatMap((key) => {
      const value = input[key];
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
        fail("LINEAR_INVALID_FIELD_VALUE", address.source);
      return value;
    });
    const ids = values.filter((value) =>
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value),
    );
    if (ids.length) {
      const cap = capability(available, linearOperationRoute("labels", "read"), address.source);
      const limit = property(cap.inputSchema, "limit");
      const team = before?.teamId ?? before?.team ?? input.team;
      const parameters: Record<string, unknown> = {
        ...(limit
          ? { limit: Math.min(250, typeof limit.maximum === "number" ? limit.maximum : 50) }
          : {}),
        ...(typeof team === "string" && property(cap.inputSchema, "team") ? { team } : {}),
      };
      const root = object((await invoke(address, cap.name, parameters, cwd, signal)).data);
      if (!Array.isArray(root.labels)) fail("LINEAR_INVALID_RESPONSE", address.source);
      const found = new Set<string>();
      for (const value of root.labels) {
        const label = object(value);
        if (typeof label.id !== "string") fail("LINEAR_INVALID_RESPONSE", address.source);
        found.add(label.id);
      }
      if (ids.some((id) => !found.has(id)))
        fail(
          root.hasNextPage === false ? "LINEAR_NOT_FOUND" : "LINEAR_LOOKUP_INCOMPLETE",
          address.source,
        );
    }
  }
  async function card(
    address: LinearFieldAddress,
    available: readonly LinearOperationCapability[],
    cwd: string,
    signal?: AbortSignal,
    fields?: readonly string[],
  ): Promise<Record<string, unknown>> {
    const route = linearOperationRoute(address.kind, "read");
    const cap = capability(available, route, address.source);
    const input = parameters(address, cap);
    if (fields) input.fields = [...fields];
    if (route?.identity && address.id && address.id !== "new") input[route.identity] = address.id;
    const result = await invoke(address, cap.name, input, cwd, signal);
    return verifiedRow(address, result.data);
  }
  /** The returned object row, after checking it is the addressed workspace object. */
  function verifiedRow(address: LinearFieldAddress, data: unknown): Record<string, unknown> {
    const root = object(data);
    const value = root[address.kind];
    const row = value && typeof value === "object" && !Array.isArray(value) ? object(value) : root;
    if (typeof row.url === "string") {
      const url = new URL(row.url);
      if (url.hostname === "linear.app" && !url.pathname.startsWith(`/${address.workspace}/`))
        fail("LINEAR_IDENTITY_MISMATCH", address.source);
    }
    if (address.id) {
      const uuid = /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(address.id);
      const identities = new Set([row.id, row.uuid, row.identifier, row.key, row.name]);
      const urlIdentity =
        typeof row.url === "string"
          ? new URL(row.url).pathname.split("/").filter(Boolean).map(decodeURIComponent)
          : [];
      if ((uuid || address.kind === "issue") && !identities.has(address.id))
        fail("LINEAR_IDENTITY_MISMATCH", address.source);
      if (
        !uuid &&
        (address.kind === "project" || address.kind === "document") &&
        !identities.has(address.id) &&
        !urlIdentity.includes(address.id)
      )
        fail("LINEAR_IDENTITY_MISMATCH", address.source);
    }
    return row;
  }
  async function readSnapshot(
    source: string,
    cwd: string,
    signal?: AbortSignal,
    fetched?: FetchedState,
  ): Promise<LinearJsonSnapshot> {
    const address = parseLinearFieldAddress(source);
    if (!address) fail("LINEAR_INVALID_URL", source);
    const available = await capabilities(address, cwd, signal);
    if (fetched) fetched.available = available;
    const action = address.facet
      ? (linearOperationRoute(address.kind, "read", address.facet) ??
        linearOperationRoute(address.kind, "write", address.facet))
      : undefined;
    const save = linearOperationRoute(address.kind, "write");
    const creator = creationRoute(address.kind, available);
    const getter = linearOperationRoute(address.kind, "read");
    const getterCapability = getter && available.find((item) => item.name === getter.operation);
    if (isCreation(address)) {
      const route = action ?? creator;
      if (route?.allowsCreation === false) fail("LINEAR_CREATION_UNSUPPORTED", source);
      return linearJsonSnapshot({
        source: address.source,
        tool: "write",
        input: resourceInputSchema(available, route, source),
      });
    }
    if (
      ["actions", "schema"].includes(address.facet ?? "") ||
      action?.mode === "write" ||
      (address.facet === "fields" && !linearOperationRoute(address.kind, "read"))
    ) {
      const routes = action
        ? [action]
        : LINEAR_OPERATION_ROUTES.filter(
            (route) => route.kind === address.kind && route.mode !== "read",
          );
      return linearJsonSnapshot({
        source: address.source,
        read: getterCapability
          ? { source: address.source.split("#")[0], input: getterCapability.inputSchema }
          : undefined,
        fields: save ? resourceInputSchema(available, save, source) : undefined,
        creation:
          creator && creator.allowsCreation !== false
            ? {
                source: `linear://${address.workspace}/${address.kind}/new`,
                tool: "write",
                input: resourceInputSchema(available, creator, source),
              }
            : undefined,
        actions: routes
          .filter(
            (route) =>
              route.facet !== "new" && available.some((item) => item.name === route.operation),
          )
          .map((route) => ({
            source:
              route.mode === "delete"
                ? address.source.split("#")[0]
                : `${address.source.split("#")[0]}${route.facet ? `#${route.facet}` : "#fields"}`,
            tool: route.mode === "delete" ? "delete" : "write",
            approvalRequired: route.dangerous === true,
            input: resourceInputSchema(available, route, source),
          })),
      });
    }
    if (action?.mode === "read") {
      const cap = capability(available, action, source);
      const input = parameters(address, cap);
      if (action.identity && address.id) input[action.identity] = address.id;
      const data = (await invoke(address, cap.name, input, cwd, signal)).data;
      return linearJsonSnapshot(
        data,
        undefined,
        linearApiPageCoverage(data, source, !!property(cap.inputSchema, "cursor")),
      );
    }
    const field = fieldName(address);
    if (field && (!save || !property(capability(available, save, source).inputSchema, field)))
      fail("LINEAR_FIELD_UNSUPPORTED", source);
    const projection =
      field && getterCapability && fieldRequestable(getterCapability, field)
        ? [field === "state" ? "status" : field]
        : undefined;
    const row = await card(address, available, cwd, signal, projection);
    // A projected row cannot provide the complete pre-save state for a later edit.
    if (fetched && !projection) fetched.row = row;
    const snapshot = snapshotFromRow(address, available, row);
    if (snapshot) return snapshot;
    return linearJsonSnapshot(undefined, display(undefined));
  }
  /** The card or field view of a row; undefined when the row does not expose the field. */
  function snapshotFromRow(
    address: LinearFieldAddress,
    available: readonly LinearOperationCapability[],
    row: Record<string, unknown>,
  ): LinearJsonSnapshot | undefined {
    const save = linearOperationRoute(address.kind, "write");
    const field = fieldName(address);
    if (!field)
      return linearJsonSnapshot(
        save ? editableCard(row, capability(available, save, address.source), save.identity) : row,
      );
    const value =
      address.kind === "issue" && field === "milestone"
        ? issueMilestoneFromCard(row)
        : valueFromCard(row, field);
    return value === undefined ? undefined : linearJsonSnapshot(value, display(value));
  }
  async function read(source: string, cwd: string, signal?: AbortSignal): Promise<string> {
    return (await readSnapshot(source, cwd, signal)).content;
  }
  async function write(
    source: string,
    content: string,
    cwd: string,
    signal?: AbortSignal,
    fetched?: FetchedState,
  ): Promise<LinearOperationReceipt> {
    const address = parseLinearFieldAddress(source);
    if (!address) fail("LINEAR_INVALID_URL", source);
    const available = fetched?.available ?? (await capabilities(address, cwd, signal));
    const action = address.facet
      ? linearOperationRoute(address.kind, "write", address.facet)
      : undefined;
    const route =
      action ??
      (isCreation(address) ? creationRoute(address.kind, available) : undefined) ??
      linearOperationRoute(address.kind, "write");
    if (isCreation(address) && route?.allowsCreation === false)
      fail("LINEAR_CREATION_UNSUPPORTED", source);
    const cap = capability(available, route, source);
    const field = action || isCreation(address) ? undefined : fieldName(address);
    if (address.kind === "document" && field === "title")
      fail("LINEAR_RENAME_REQUIRES_MOVE", source);
    let input = parameters(address, cap);
    try {
      if (field) {
        const schema = property(cap.inputSchema, field);
        if (!schema) fail("LINEAR_FIELD_UNSUPPORTED", source);
        const wanted = parseValue(content, schema);
        if (!accepts(schema, wanted)) fail("LINEAR_INVALID_FIELD_VALUE", source);
        input[field] = wanted;
      } else {
        const payload = object(JSON.parse(content));
        if (route?.identity && Object.hasOwn(payload, route.identity))
          fail("LINEAR_IDENTITY_OVERRIDE", source);
        if (address.kind === "document" && !isCreation(address) && Object.hasOwn(payload, "title"))
          fail("LINEAR_RENAME_REQUIRES_MOVE", source);
        input = { ...input, ...payload };
      }
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      fail("LINEAR_INVALID_FIELD_VALUE", source);
    }
    let before: Record<string, unknown> | undefined;
    if (!isCreation(address) && linearOperationRoute(address.kind, "read")) {
      // The card this resolved resource just read is the pre-save state; another read would
      // only repeat it. Each write consumes it, so a later write reads a fresh card.
      before = fetched?.row ?? (await card(address, available, cwd, signal));
      if (fetched) fetched.row = undefined;
    }
    if (route?.identity && !isCreation(address)) {
      const identity = before?.uuid ?? before?.id ?? address.id;
      if (typeof identity !== "string" || !identity) fail("LINEAR_IDENTITY_REQUIRED", source);
      input[route.identity] = identity;
    }
    if (address.kind === "workflow-skill" && before) {
      // Native saves require the full managed content; scalar edits retain the other fields.
      for (const key of ["teamId", "title", "body"])
        if (!Object.hasOwn(input, key)) input[key] = before[key];
    }
    if (isCreation(address)) {
      if (
        address.kind === "issue" &&
        ((typeof input.title !== "string" && typeof input.template !== "string") ||
          typeof input.team !== "string")
      )
        fail("LINEAR_CREATE_FIELDS_REQUIRED", source);
      if (address.kind === "project" && typeof input.name !== "string")
        fail("LINEAR_CREATE_FIELDS_REQUIRED", source);
    }
    if (route?.dangerous || address.kind.startsWith("diff")) {
      if (!requirePermit) fail("LINEAR_CONFIRMATION_REQUIRED", source);
      requirePermit(source, content);
    }
    if (address.kind === "issue" && !action)
      await prepareIssueInput(address, available, input, before, cwd, signal);
    if (address.kind === "customer-request" && before && !action) {
      if (input.project === address.parameters.project) input.project = before.project;
      if (typeof input.issue === "string") {
        const getter = capability(available, linearOperationRoute("issue", "read"), source);
        const root = object(
          (await invoke(address, getter.name, { id: input.issue }, cwd, signal)).data,
        );
        const issue = root.issue ? object(root.issue) : root;
        const id = issue.uuid ?? issue.id;
        if (
          typeof id !== "string" ||
          !isDocumentId(id) ||
          ![issue.id, issue.uuid, issue.identifier].includes(input.issue)
        )
          fail("LINEAR_IDENTITY_MISMATCH", source);
        input.issue = id;
      }
    }
    // Linear owns the saved representation. An acknowledged write needs no equality gate.
    try {
      return await invoke(address, cap.name, input, cwd, signal);
    } catch (error) {
      if (
        !(error instanceof ResourceError) ||
        error.effect !== "unknown" ||
        action ||
        isCreation(address) ||
        !before
      )
        throw error;
      // The request may have been lost after Linear applied it. A readback that already shows
      // every requested value settles the effect; anything else stays unknown. Nothing is resent.
      const saved = await savedValues(address, available, input, route?.identity, cwd, signal);
      if (!saved) throw error;
      return { workspace: address.workspace, operation: cap.name, effect: "applied", data: saved };
    }
  }
  async function savedValues(
    address: LinearFieldAddress,
    available: readonly LinearOperationCapability[],
    input: Record<string, unknown>,
    identity: string | undefined,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    let row: Record<string, unknown>;
    try {
      row = await card(address, available, cwd, signal);
    } catch {
      return undefined;
    }
    const fields = Object.entries(input).filter(([key]) => key !== identity);
    return fields.length > 0 &&
      fields.every(([key, value]) => isDeepStrictEqual(valueFromCard(row, key), value))
      ? row
      : undefined;
  }
  const resolver: ResourceResolver = {
    id: "linear-fields",
    async tryResolve(source, context) {
      const address = parseLinearFieldAddress(source);
      if (
        !address ||
        (!address.facet && !isCreation(address)) ||
        ["comments", "subtasks", "attachments", "file"].includes(address.facet ?? "")
      )
        return { kind: "not-handled" };
      if (
        ["actions", "schema"].includes(address.facet ?? "") ||
        isCreation(address) ||
        (address.facet === "fields" && !linearOperationRoute(address.kind, "read")) ||
        (address.facet && linearOperationRoute(address.kind, "write", address.facet)) ||
        (address.facet && linearOperationRoute(address.kind, "read", address.facet))
      ) {
        const snapshot = await readSnapshot(source, context.cwd, context.signal);
        return {
          kind: "resolved",
          resource: {
            source,
            read: async () => linearJsonContent(snapshot),
            sourceBytes: Buffer.from(snapshot.content),
          },
        };
      }
      let snapshot: LinearJsonSnapshot;
      const fetched: FetchedState = {};
      try {
        snapshot = await readSnapshot(source, context.cwd, context.signal, fetched);
      } catch (error) {
        if (
          !["priority", "assignee", "estimate", "labels"].includes(address.facet ?? "") &&
          !(address.kind === "issue" && address.facet === "milestone")
        )
          throw error;
        const code =
          error instanceof Error && /^LINEAR_[A-Z_]+$/u.test(error.message)
            ? error.message
            : "LINEAR_FIELD_READ_FAILED";
        return {
          kind: "failed",
          error:
            error instanceof ResourceError ? error : new ResourceError(code, source, "not-applied"),
        };
      }
      let expected: LinearJsonSnapshot | undefined = snapshot;
      const current = async (
        signal?: AbortSignal,
        effect: "applied" | "not-applied" = "applied",
      ): Promise<LinearJsonSnapshot> => {
        if (expected !== undefined) return expected;
        try {
          return (expected = await readSnapshot(source, context.cwd, signal));
        } catch {
          throw new ResourceError("LINEAR_READBACK_UNAVAILABLE", source, effect);
        }
      };
      return {
        kind: "resolved",
        resource: {
          source,
          get sourceBytes() {
            return expected === undefined ? undefined : Buffer.from(expected.content);
          },
          read: async (operation) => linearJsonContent(await current(operation.signal)),
          async write(blocks, operation) {
            if (blocks.length !== 1 || blocks[0].type !== "text")
              fail("LINEAR_TEXT_REQUIRED", source);
            const receipt = await write(
              source,
              blocks[0].text,
              context.cwd,
              operation.signal,
              fetched,
            );
            // The save response is Linear's saved representation, so the next Read uses it
            // instead of another request. Without a usable row the next Read fetches one;
            // success never depends on it.
            expected = undefined;
            try {
              if (fetched.available && receipt.data !== undefined)
                expected = snapshotFromRow(
                  address,
                  fetched.available,
                  verifiedRow(address, receipt.data),
                );
            } catch {
              expected = undefined;
            }
          },
        },
      };
    },
  };
  return { read, write, resolver };
}
