import { ResourceError } from "pi-agent-ide/api/resource";
import type {
  LinearOperationBackend,
  LinearOperationCapability,
  LinearOperationReceipt,
} from "./operation-backend.ts";
import { isDocumentId } from "./urls.ts";

const lookupPages = 5;
const pageSize = 50;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LINEAR_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function fail(
  code: string,
  source: string,
  effect: "not-applied" | "unknown" = "not-applied",
): never {
  throw new ResourceError(code, source, effect);
}
function text(value: unknown, source: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    fail("LINEAR_OPERATION_INPUT_REQUIRED", source);
  return value;
}

/** Keep the project scope in a request's stable address; the MCP has no request-by-ID getter. */
export function customerRequestSource(workspace: string, id: string, project: string): string {
  const url = new URL(`linear://${workspace}/customer-request/${encodeURIComponent(id)}`);
  url.searchParams.set("project", project);
  return url.href;
}

/** Add a local, bounded scoped getter; all remote calls still use AXI's fixed MCP transport. */
export function createCustomerRequestBackend(
  backend: LinearOperationBackend,
): LinearOperationBackend {
  async function invoke(
    workspace: string,
    operation: string,
    input: Readonly<Record<string, unknown>>,
    cwd: string,
    signal: AbortSignal | undefined,
    source: string,
  ): Promise<LinearOperationReceipt> {
    signal?.throwIfAborted();
    const receipt = await backend.invoke(workspace, operation, input, cwd, signal);
    if (receipt.workspace !== workspace || receipt.operation !== operation)
      fail(
        "LINEAR_IDENTITY_MISMATCH",
        source,
        operation === "save_customer_need" ? "unknown" : "not-applied",
      );
    return receipt;
  }
  async function row(
    workspace: string,
    operation: string,
    input: Readonly<Record<string, unknown>>,
    cwd: string,
    signal: AbortSignal | undefined,
    source: string,
  ): Promise<Record<string, unknown>> {
    const receipt = await invoke(workspace, operation, input, cwd, signal, source);
    if (receipt.effect !== "applied" || receipt.error)
      fail(receipt.error ?? "LINEAR_RESOURCE_READ_FAILED", source);
    const root = record(receipt.data);
    const result = record(root[operation === "get_project" ? "project" : "issue"] ?? root);
    if (typeof result.url === "string") {
      const url = new URL(result.url);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "linear.app" ||
        url.pathname.split("/")[1] !== workspace ||
        url.username ||
        url.password
      )
        fail("LINEAR_IDENTITY_MISMATCH", source);
    }
    return result;
  }
  async function projectId(
    workspace: string,
    project: string,
    cwd: string,
    signal: AbortSignal | undefined,
    source: string,
  ) {
    const projectRow = await row(workspace, "get_project", { query: project }, cwd, signal, source);
    const id = projectRow.uuid ?? projectRow.id;
    if (typeof id !== "string" || !isDocumentId(id) || (isDocumentId(project) && id !== project))
      fail("LINEAR_IDENTITY_MISMATCH", source);
    return id;
  }
  async function issueRow(
    workspace: string,
    issue: string,
    project: string,
    cwd: string,
    signal: AbortSignal | undefined,
    source: string,
  ) {
    const result = await row(workspace, "get_issue", { id: issue }, cwd, signal, source);
    const uuid = result.uuid ?? result.id;
    if (
      typeof uuid !== "string" ||
      !isDocumentId(uuid) ||
      ![result.id, result.uuid, result.identifier].includes(issue) ||
      result.projectId !== project
    )
      fail("LINEAR_IDENTITY_MISMATCH", source);
    return { ...result, uuid };
  }
  async function request(
    workspace: string,
    id: string,
    project: string,
    cwd: string,
    signal: AbortSignal | undefined,
    source: string,
  ) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < lookupPages; page++) {
      const receipt = await invoke(
        workspace,
        "list_customer_needs",
        {
          project,
          limit: pageSize,
          ...(cursor ? { cursor } : {}),
        },
        cwd,
        signal,
        source,
      );
      if (receipt.effect !== "applied" || receipt.error)
        fail(receipt.error ?? "LINEAR_RESOURCE_READ_FAILED", source);
      const data = record(receipt.data);
      if (!Array.isArray(data.customerNeeds) || data.customerNeeds.length > pageSize)
        fail("LINEAR_INVALID_RESPONSE", source);
      const match = data.customerNeeds.map(record).find((item) => item.id === id);
      if (match) {
        const projectDetails = record(match.project);
        const customerDetails = record(match.customer);
        if (projectDetails.id !== project || typeof customerDetails.id !== "string")
          fail("LINEAR_IDENTITY_MISMATCH", source);
        let linked: Record<string, unknown> | undefined;
        if (match.issue !== undefined && match.issue !== null) {
          const details = record(match.issue);
          linked = await issueRow(
            workspace,
            text(details.uuid ?? details.id, source),
            project,
            cwd,
            signal,
            source,
          );
        }
        const body = match.body ?? match.content;
        if (typeof body !== "string") fail("LINEAR_FIELD_NOT_EXPOSED", source);
        return {
          ...match,
          body,
          customer: customerDetails.id,
          customerDetails,
          project,
          projectDetails,
          issue: linked?.uuid ?? null,
          ...(match.issue ? { issueDetails: match.issue } : {}),
        };
      }
      const info = data.pageInfo ? record(data.pageInfo) : data;
      if (info.hasNextPage === false) fail("LINEAR_NOT_FOUND", source);
      if (info.hasNextPage !== true) fail("LINEAR_PAGINATION_UNVERIFIED", source);
      const next = info.endCursor ?? data.cursor ?? data.nextCursor;
      if (
        typeof next !== "string" ||
        !next ||
        next.length > 1024 ||
        /[\r\n]/u.test(next) ||
        seen.has(next)
      )
        fail("LINEAR_PAGINATION_UNVERIFIED", source);
      seen.add(next);
      cursor = next;
    }
    fail("LINEAR_LOOKUP_INCOMPLETE", source);
  }
  return {
    async capabilities(workspace, cwd, signal) {
      const available = await backend.capabilities(workspace, cwd, signal);
      if (
        !["list_customer_needs", "get_project", "get_issue"].every((name) =>
          available.some((cap) => cap.name === name),
        )
      )
        return available;
      const getter: LinearOperationCapability = {
        name: "get_customer_request",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, project: { type: "string" } },
          required: ["id", "project"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      };
      return [
        ...available.map((cap) => {
          if (cap.name !== "save_customer_need") return cap;
          const properties = record(cap.inputSchema.properties);
          return {
            ...cap,
            inputSchema: {
              ...cap.inputSchema,
              properties: {
                ...properties,
                project: {
                  ...record(properties.project),
                  description:
                    "Use the project for creation or scoped lookup. Keep an existing request in its original project.",
                },
              },
            },
          };
        }),
        getter,
      ];
    },
    async invoke(workspace, operation, input, cwd, signal) {
      if (operation !== "get_customer_request" && operation !== "save_customer_need")
        return backend.invoke(workspace, operation, input, cwd, signal);
      const id =
        input.id === undefined ? "new" : text(input.id, `linear://${workspace}/customer-request`);
      const scope = text(input.project, `linear://${workspace}/customer-request/${id}`);
      const source = customerRequestSource(workspace, id, scope);
      if (id !== "new" && !isDocumentId(id)) fail("LINEAR_IDENTITY_MISMATCH", source);
      const project = await projectId(workspace, scope, cwd, signal, source);
      if (operation === "get_customer_request") {
        if (id === "new") fail("LINEAR_IDENTITY_REQUIRED", source);
        const data = await request(workspace, id, project, cwd, signal, source);
        return { workspace, operation, effect: "applied", data };
      }
      const payload = { ...input };
      if (id === "new") {
        if (
          typeof input.body !== "string" ||
          !input.body.trim() ||
          typeof input.customer !== "string" ||
          !input.customer.trim()
        )
          fail("LINEAR_CREATE_FIELDS_REQUIRED", source);
        if (input.issue !== undefined) fail("LINEAR_INVALID_OPERATION_INPUT", source);
        payload.project = project;
      } else {
        const before = await request(workspace, id, project, cwd, signal, source);
        if (input.customer !== undefined && input.customer !== before.customer)
          fail("LINEAR_IDENTITY_MISMATCH", source);
        // Project is the read scope, not an instruction to move or unlink the request.
        delete payload.project;
        if (input.issue !== undefined) {
          const issue = await issueRow(
            workspace,
            text(input.issue, source),
            project,
            cwd,
            signal,
            source,
          );
          payload.issue = issue.uuid;
        }
      }
      const receipt = await invoke(workspace, operation, payload, cwd, signal, source);
      if (receipt.effect !== "applied" || receipt.error || id !== "new") return receipt;
      if (!receipt.data || typeof receipt.data !== "object" || Array.isArray(receipt.data))
        fail("LINEAR_CREATION_RECEIPT_INVALID", source, "unknown");
      const saved = record(receipt.data);
      if (typeof saved.id !== "string" || !isDocumentId(saved.id))
        fail("LINEAR_CREATION_RECEIPT_INVALID", source, "unknown");
      return { ...receipt, data: { ...saved, requestScopeProject: project } };
    },
  };
}
