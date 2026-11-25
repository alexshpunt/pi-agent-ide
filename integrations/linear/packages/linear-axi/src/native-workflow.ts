import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { authorizationHeader, type NativeTokenProvider } from "./app-token.ts";
import { isRecord, isUnknownArray, type InputRecord, type McpTool } from "./types.ts";
import { CONNECTION_FAILURES, isConnectionFailure } from "./lib/connection-failure.ts";
import {
  LinearRateLimitError,
  rateLimitInfoFromError,
  rejectRateLimit,
  type RateLimitInfo,
  type RateLimitObserver,
} from "./rate-limit.ts";

/** Fixed App operations for managed workflow resources, never arbitrary GraphQL. */
export const WORKFLOW_OPERATIONS = [
  "get_workflow_skill",
  "list_workflow_skills",
  "save_workflow_skill",
  "get_workflow_template",
  "create_workflow_template",
  "update_workflow_template",
  "delete_document",
  "delete_workflow_skill",
  "delete_workflow_template",
] as const;
export type WorkflowOperation = (typeof WORKFLOW_OPERATIONS)[number];
/** An acknowledged native effect, or a safe failure retaining the exact target identity. */
export interface WorkflowReceipt {
  effect: "applied" | "not-applied" | "unknown";
  data: unknown;
  error?: string;
  rateLimit?: RateLimitInfo;
  targetId?: string;
}
export interface WorkflowCapability extends McpTool {
  name: WorkflowOperation;
  inputSchema: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const uuidSchema = { type: "string", pattern: UUID.source.replaceAll("a-f", "a-fA-F") };
const textSchema = { type: "string", maxLength: 1024 * 1024 };
const nodeSchema = {
  type: "object",
  required: ["type"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1, maxLength: 64 },
    text: textSchema,
    attrs: { type: "object", additionalProperties: true },
    content: { type: "array", items: { $ref: "#/$defs/node" } },
    marks: {
      type: "array",
      items: {
        type: "object",
        required: ["type"],
        additionalProperties: false,
        properties: {
          type: { type: "string", minLength: 1 },
          attrs: { type: "object", additionalProperties: true },
        },
      },
    },
  },
};
function capability(
  name: WorkflowOperation,
  properties: Record<string, unknown>,
  required: string[],
): WorkflowCapability {
  return {
    name,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties,
      required,
      additionalProperties: false,
      ...(["update_workflow_template", "create_workflow_template"].includes(name)
        ? { $defs: { node: nodeSchema } }
        : {}),
    },
    annotations: {
      readOnlyHint: name.startsWith("get_") || name.startsWith("list_"),
      destructiveHint: name.startsWith("delete_"),
      idempotentHint:
        !name.startsWith("delete_") &&
        !["save_workflow_skill", "create_workflow_template"].includes(name),
    },
  };
}
const CAPABILITIES = [
  capability("delete_document", { id: uuidSchema }, ["id"]),
  capability("delete_workflow_skill", { id: uuidSchema }, ["id"]),
  capability("delete_workflow_template", { id: uuidSchema }, ["id"]),
  capability("get_workflow_skill", { id: uuidSchema }, ["id"]),
  capability(
    "list_workflow_skills",
    {
      teamId: uuidSchema,
      limit: { type: "integer", minimum: 1, maximum: 50, default: 50 },
      cursor: { type: "string", minLength: 1, maxLength: 4096 },
    },
    ["teamId"],
  ),
  capability(
    "save_workflow_skill",
    {
      id: uuidSchema,
      teamId: uuidSchema,
      title: { type: "string", minLength: 1, maxLength: 256, pattern: "\\S" },
      body: textSchema,
    },
    ["teamId", "title", "body"],
  ),
  capability("get_workflow_template", { id: uuidSchema }, ["id"]),
  capability(
    "create_workflow_template",
    {
      name: { type: "string", minLength: 1, maxLength: 256, pattern: "\\S" },
      type: { type: "string", enum: ["issue", "document"] },
      teamId: { ...uuidSchema, description: "Verified team UUID. Omit for workspace scope." },
      title: { type: "string", maxLength: 256, description: "Default issue or document title." },
      priority: {
        type: "integer",
        minimum: 0,
        maximum: 4,
        description: "Issue templates only: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low.",
      },
      description: {
        type: "string",
        maxLength: 8192,
        description: "Template help text, separate from the body.",
      },
      descriptionData: {
        type: "object",
        required: ["type", "content"],
        additionalProperties: false,
        properties: {
          type: { const: "doc" },
          content: { type: "array", items: { $ref: "#/$defs/node" } },
        },
      },
    },
    ["name", "type", "descriptionData"],
  ),
  capability(
    "update_workflow_template",
    {
      id: uuidSchema,
      descriptionData: {
        type: "object",
        required: ["type", "content"],
        additionalProperties: false,
        properties: {
          type: { const: "doc" },
          content: { type: "array", items: { $ref: "#/$defs/node" } },
        },
      },
      description: { type: "string", maxLength: 8192 },
    },
    ["id", "descriptionData"],
  ),
];
const SKILL_FIELDS =
  "id title body teamId shared inheritedFrom { id } owner { organization { id urlKey } } icon color";
const TEMPLATE_FIELDS =
  "id name type description templateData content organization { id urlKey } team { id organization { id urlKey } } inheritedFrom { id } icon color sortOrder";
const DOCUMENT_FIELDS = "id title url slugId trashed archivedAt";
const VIEWER = "viewer { organization { id urlKey } }";
const SAFE_ERRORS = new Set([
  ...CONNECTION_FAILURES,
  "LINEAR_INPUT_INVALID",
  "LINEAR_RESOURCE_UNSUPPORTED",
  "LINEAR_INVALID_RESPONSE",
  "LINEAR_IDENTITY_MISMATCH",
  "LINEAR_GRAPHQL_AUTH_REQUIRED",
  "LINEAR_PERMISSION_DENIED",
  "LINEAR_RATE_LIMITED",
  "LINEAR_GRAPHQL_FAILED",
  "LINEAR_SAVED_FIELD_MISMATCH",
]);
interface Attempt {
  pinAuthorization?: boolean;
  dispatched: boolean;
  targetId?: string;
}
function fail(code: string): never {
  throw new Error(code);
}
function record(value: unknown): InputRecord {
  if (!isRecord(value)) fail("LINEAR_INVALID_RESPONSE");
  return value;
}
function requireUuid(value: unknown, error: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) fail(error);
}
function uuid(value: unknown, error = "LINEAR_INPUT_INVALID"): string {
  requireUuid(value, error);
  return value.toLowerCase();
}
interface WorkflowOrganization extends InputRecord {
  id: string;
}

function organization(
  value: unknown,
  workspace: string,
  expectedId?: string,
): WorkflowOrganization {
  const org = record(value);
  const id = org.id;
  requireUuid(id, "LINEAR_INVALID_RESPONSE");
  if (org.urlKey !== workspace || (expectedId && org.id !== expectedId))
    fail("LINEAR_IDENTITY_MISMATCH");
  return { ...org, id };
}
function viewer(root: InputRecord, workspace: string, expectedId?: string): WorkflowOrganization {
  return organization(record(root.viewer).organization, workspace, expectedId);
}
function inheritance(value: unknown): void {
  if (value !== null) uuid(record(value).id, "LINEAR_INVALID_RESPONSE");
}
function document(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.type !== "doc" ||
    !isUnknownArray(value.content) ||
    Object.keys(value).some((k) => !["type", "content"].includes(k))
  )
    return false;
  let count = 0;
  const node = (v: unknown, depth: number): boolean => {
    if (
      ++count > 10000 ||
      depth > 32 ||
      !isRecord(v) ||
      typeof v.type !== "string" ||
      !v.type.length ||
      v.type.length > 64
    )
      return false;
    if (Object.keys(v).some((k) => !["type", "text", "attrs", "content", "marks"].includes(k)))
      return false;
    if (
      (v.type === "text" && typeof v.text !== "string") ||
      (v.text !== undefined && typeof v.text !== "string")
    )
      return false;
    if (v.attrs !== undefined && !isRecord(v.attrs)) return false;
    if (
      v.marks !== undefined &&
      (!isUnknownArray(v.marks) ||
        !v.marks.every(
          (m) =>
            isRecord(m) &&
            typeof m.type === "string" &&
            m.type.length &&
            Object.keys(m).every((k) => ["type", "attrs"].includes(k)) &&
            (m.attrs === undefined || isRecord(m.attrs)),
        ))
    )
      return false;
    return (
      v.content === undefined ||
      (isUnknownArray(v.content) && v.content.every((c) => node(c, depth + 1)))
    );
  };
  return value.content.every((v) => node(v, 0));
}
function validate(
  operation: string,
  input: unknown,
  workspace: string,
): asserts input is InputRecord {
  const schema = CAPABILITIES.find((c) => c.name === operation)?.inputSchema;
  if (!schema) fail("LINEAR_RESOURCE_UNSUPPORTED");
  if (!/^[A-Za-z0-9_-]+$/u.test(workspace) || !isRecord(input)) fail("LINEAR_INPUT_INVALID");
  const properties = schema.properties as InputRecord;
  if (
    Object.keys(input).some((k) => !Object.hasOwn(properties, k)) ||
    (schema.required as string[]).some((k) => !Object.hasOwn(input, k))
  )
    fail("LINEAR_INPUT_INVALID");
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 2 * 1024 * 1024)
    fail("LINEAR_INPUT_INVALID");
  if (input.id !== undefined) uuid(input.id);
  if (input.teamId !== undefined) uuid(input.teamId);
  if (operation === "list_workflow_skills") {
    if (
      input.limit !== undefined &&
      (typeof input.limit !== "number" ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 50)
    )
      fail("LINEAR_INPUT_INVALID");
    if (
      input.cursor !== undefined &&
      (typeof input.cursor !== "string" || !input.cursor.trim() || input.cursor.length > 4096)
    )
      fail("LINEAR_INPUT_INVALID");
  }
  if (
    operation === "save_workflow_skill" &&
    (typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 256 ||
      typeof input.body !== "string" ||
      input.body.length > 1024 * 1024)
  )
    fail("LINEAR_INPUT_INVALID");
  if (
    ["update_workflow_template", "create_workflow_template"].includes(operation) &&
    (!document(input.descriptionData) ||
      (input.description !== undefined &&
        (typeof input.description !== "string" || input.description.length > 8192)))
  )
    fail("LINEAR_INPUT_INVALID");
  if (
    operation === "create_workflow_template" &&
    (typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 256 ||
      (input.type !== "issue" && input.type !== "document") ||
      (input.title !== undefined &&
        (typeof input.title !== "string" || input.title.length > 256)) ||
      (input.priority !== undefined &&
        (input.type !== "issue" ||
          typeof input.priority !== "number" ||
          !Number.isInteger(input.priority) ||
          input.priority < 0 ||
          input.priority > 4)))
  )
    fail("LINEAR_INPUT_INVALID");
}

/** Fixed native workflow transport. App ownership is independent of the caller's MCP actor. */
export class NativeWorkflowClient {
  private readonly options: {
    endpoint?: string;
    tokenProvider: NativeTokenProvider;
    fetchImpl?: typeof fetch;
    onRateLimit?: RateLimitObserver;
  };
  constructor(options: {
    endpoint?: string;
    tokenProvider: NativeTokenProvider;
    fetchImpl?: typeof fetch;
    onRateLimit?: RateLimitObserver;
  }) {
    this.options = options;
  }
  /** Advertise only implemented local schemas; availability is not a promise of write permission. */
  capabilities(): WorkflowCapability[] {
    return structuredClone(CAPABILITIES);
  }
  /** Validate and verify scopes before saving. Every dispatched mutation is attempted exactly once. */
  async invoke(
    operation: WorkflowOperation,
    input: unknown,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<WorkflowReceipt> {
    const attempt: Attempt = { dispatched: false };
    try {
      validate(operation, input, workspace);
      if (input.id) attempt.targetId = uuid(input.id);
      if (
        (operation === "save_workflow_skill" && !input.id) ||
        operation === "create_workflow_template"
      )
        attempt.targetId = randomUUID();
      let data: unknown;
      switch (operation) {
        case "delete_document":
        case "delete_workflow_skill":
        case "delete_workflow_template": {
          data = await this.deleteResource(operation, uuid(input.id), workspace, attempt, signal);
          break;
        }
        case "get_workflow_skill": {
          data = await this.skill(uuid(input.id), workspace, signal);
          break;
        }
        case "get_workflow_template": {
          data = await this.template(uuid(input.id), workspace, signal);
          break;
        }
        case "list_workflow_skills": {
          data = await this.list(input, workspace, signal);
          break;
        }
        case "save_workflow_skill": {
          data = await this.save(input, workspace, attempt, signal);
          break;
        }
        case "create_workflow_template": {
          data = await this.createTemplate(input, workspace, attempt, signal);
          break;
        }
        case "update_workflow_template": {
          data = await this.updateTemplate(input, workspace, attempt, signal);
          break;
        }
      }
      return {
        effect: "applied",
        data,
        ...(attempt.targetId ? { targetId: attempt.targetId } : {}),
      };
    } catch (error) {
      const rateLimit = rateLimitInfoFromError(error);
      return {
        effect: attempt.dispatched ? "unknown" : "not-applied",
        data: null,
        error:
          error instanceof Error && SAFE_ERRORS.has(error.message)
            ? error.message
            : "LINEAR_GRAPHQL_FAILED",
        ...(rateLimit ? { rateLimit } : {}),
        ...(attempt.targetId ? { targetId: attempt.targetId } : {}),
      };
    }
  }
  private async request(
    query: string,
    variables: InputRecord,
    signal?: AbortSignal,
    attempt?: Attempt,
  ): Promise<InputRecord> {
    const bounded = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
    bounded.throwIfAborted();
    let token: string;
    try {
      token = await authorizationHeader(this.options.tokenProvider);
    } catch (error) {
      if (isConnectionFailure(error)) throw error;
      fail("LINEAR_GRAPHQL_AUTH_REQUIRED");
    }
    if (attempt?.pinAuthorization) await this.options.tokenProvider.assertCurrentAuthorization?.();
    bounded.throwIfAborted();
    if (attempt) attempt.dispatched = true;
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(
        this.options.endpoint ?? "https://api.linear.app/graphql",
        {
          method: "POST",
          headers: { authorization: token, "content-type": "application/json" },
          body: JSON.stringify({ query, variables }),
          signal: bounded,
          redirect: "error",
        },
      );
    } catch (error) {
      if (error instanceof LinearRateLimitError || isConnectionFailure(error)) throw error;
      fail("LINEAR_GRAPHQL_FAILED");
    }
    if (response.status === 401) fail("LINEAR_GRAPHQL_AUTH_REQUIRED");
    if (response.status === 403) fail("LINEAR_PERMISSION_DENIED");
    if (response.status === 429) fail("LINEAR_RATE_LIMITED");
    if (!response.ok && response.status !== 400) fail("LINEAR_GRAPHQL_FAILED");
    let payload: InputRecord;
    try {
      payload = record(await response.json());
    } catch {
      fail("LINEAR_INVALID_RESPONSE");
    }
    if (payload.errors !== undefined) {
      if (!isUnknownArray(payload.errors)) fail("LINEAR_INVALID_RESPONSE");
      if (payload.errors.length) {
        const codes = new Set(
          payload.errors.map((e) =>
            isRecord(e) && isRecord(e.extensions) ? e.extensions.code : undefined,
          ),
        );
        if (codes.has("FORBIDDEN")) fail("LINEAR_PERMISSION_DENIED");
        if (codes.has("UNAUTHENTICATED")) fail("LINEAR_GRAPHQL_AUTH_REQUIRED");
        if (codes.has("RATELIMITED") || codes.has("RATE_LIMITED"))
          return rejectRateLimit(response.headers, this.options.onRateLimit);
        fail("LINEAR_GRAPHQL_FAILED");
      }
    }
    if (!response.ok) fail("LINEAR_GRAPHQL_FAILED");
    return record(payload.data);
  }
  private async team(
    id: string,
    workspace: string,
    signal?: AbortSignal,
    expectedOrg?: string,
  ): Promise<WorkflowOrganization> {
    const root = await this.request(
      `query WorkflowTeam($id: String!) { ${VIEWER} team(id: $id) { id organization { id urlKey } } }`,
      { id },
      signal,
    );
    const org = viewer(root, workspace, expectedOrg);
    const value = record(root.team);
    if (value.id !== id) fail("LINEAR_IDENTITY_MISMATCH");
    organization(value.organization, workspace, org.id);
    return org;
  }
  private skillRecord(
    value: unknown,
    workspace: string,
    orgId: string,
    expectedId?: string,
    expectedTeam?: string,
  ): InputRecord & { teamId: string | null } {
    const result = record(value);
    uuid(result.id, "LINEAR_INVALID_RESPONSE");
    if (expectedId && result.id !== expectedId) fail("LINEAR_IDENTITY_MISMATCH");
    if (
      typeof result.title !== "string" ||
      typeof result.body !== "string" ||
      typeof result.shared !== "boolean"
    )
      fail("LINEAR_INVALID_RESPONSE");
    const teamId = result.teamId;
    if (teamId !== null) requireUuid(teamId, "LINEAR_INVALID_RESPONSE");
    if (expectedTeam && result.teamId !== expectedTeam) fail("LINEAR_IDENTITY_MISMATCH");
    inheritance(result.inheritedFrom);
    organization(record(result.owner).organization, workspace, orgId);
    return { ...result, teamId, workspace, scope: teamId === null ? "personal" : "team" };
  }
  private async skill(
    id: string,
    workspace: string,
    signal?: AbortSignal,
    verifiedTeam?: { id: string; organizationId: string },
  ): Promise<InputRecord> {
    const root = await this.request(
      `query WorkflowSkill($id: String!) { ${VIEWER} skill: agentSkill(id: $id) { ${SKILL_FIELDS} } }`,
      { id },
      signal,
    );
    const org = viewer(root, workspace, verifiedTeam?.organizationId);
    const result = this.skillRecord(root.skill, workspace, org.id, id, verifiedTeam?.id);
    if (result.teamId !== null && !verifiedTeam)
      await this.team(result.teamId, workspace, signal, org.id);
    return result;
  }
  private async list(
    input: InputRecord,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<InputRecord> {
    const teamId = uuid(input.teamId);
    const org = await this.team(teamId, workspace, signal);
    const first = typeof input.limit === "number" ? input.limit : 50;
    const root = await this.request(
      `query WorkflowSkillList($teamId: ID!, $first: Int!, $after: String) { ${VIEWER} agentSkills(first: $first, after: $after, filter: { team: { id: { eq: $teamId } } }) { nodes { ${SKILL_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { teamId, first, after: input.cursor ?? null },
      signal,
    );
    viewer(root, workspace, org.id);
    const connection = record(root.agentSkills);
    const page = record(connection.pageInfo);
    if (
      !isUnknownArray(connection.nodes) ||
      connection.nodes.length > first ||
      typeof page.hasNextPage !== "boolean" ||
      (page.endCursor !== null && typeof page.endCursor !== "string") ||
      (page.hasNextPage && !page.endCursor?.trim())
    )
      fail("LINEAR_INVALID_RESPONSE");
    const skills = connection.nodes.map((value) =>
      this.skillRecord(value, workspace, org.id, undefined, teamId),
    );
    if (new Set(skills.map((s) => s.id)).size !== skills.length) fail("LINEAR_INVALID_RESPONSE");
    return { skills, teamId, workspace, hasNextPage: page.hasNextPage, cursor: page.endCursor };
  }
  private templateRecord(
    value: unknown,
    workspace: string,
    orgId: string,
    id: string,
  ): InputRecord & { type: string; templateData: string; organization: WorkflowOrganization } {
    const result = record(value);
    if (result.id !== id) fail("LINEAR_IDENTITY_MISMATCH");
    if (
      typeof result.name !== "string" ||
      typeof result.type !== "string" ||
      typeof result.templateData !== "string" ||
      (result.description !== null && typeof result.description !== "string") ||
      (result.content !== null && typeof result.content !== "string")
    )
      fail("LINEAR_INVALID_RESPONSE");
    const org = organization(result.organization, workspace, orgId);
    inheritance(result.inheritedFrom);
    let teamId: string | null = null;
    if (result.team !== null) {
      const actualTeam = record(result.team);
      const actualId = actualTeam.id;
      requireUuid(actualId, "LINEAR_INVALID_RESPONSE");
      teamId = actualId;
      organization(actualTeam.organization, workspace, orgId);
    }
    return {
      ...result,
      workspace,
      organization: org,
      type: result.type,
      templateData: result.templateData,
      teamId,
      scope: result.team === null ? "workspace" : "team",
    };
  }
  private async template(id: string, workspace: string, signal?: AbortSignal) {
    const root = await this.request(
      `query WorkflowTemplate($id: String!) { ${VIEWER} template(id: $id) { ${TEMPLATE_FIELDS} } }`,
      { id },
      signal,
    );
    const org = viewer(root, workspace);
    return this.templateRecord(root.template, workspace, org.id, id);
  }
  private documentRecord(value: unknown, id: string, workspace: string): InputRecord {
    const result = record(value);
    if (result.id !== id) fail("LINEAR_IDENTITY_MISMATCH");
    if (
      typeof result.title !== "string" ||
      typeof result.url !== "string" ||
      typeof result.slugId !== "string" ||
      !/^[a-z0-9]+$/iu.test(result.slugId) ||
      (result.trashed !== null && typeof result.trashed !== "boolean") ||
      (result.archivedAt !== null && typeof result.archivedAt !== "string")
    )
      fail("LINEAR_INVALID_RESPONSE");
    let url: URL;
    try {
      url = new URL(result.url);
    } catch {
      fail("LINEAR_INVALID_RESPONSE");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "linear.app" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      parts.length !== 3 ||
      parts[0] !== workspace ||
      parts[1] !== "document" ||
      !parts[2].endsWith(`-${result.slugId}`)
    )
      fail("LINEAR_IDENTITY_MISMATCH");
    return { ...result, workspace };
  }
  private async deleteResource(
    operation: "delete_document" | "delete_workflow_skill" | "delete_workflow_template",
    id: string,
    workspace: string,
    attempt: Attempt,
    signal?: AbortSignal,
  ): Promise<InputRecord> {
    let mutation: string;
    attempt.pinAuthorization = true;
    if (operation === "delete_workflow_skill") {
      const existing = await this.skill(id, workspace, signal);
      if (existing.teamId === null || existing.inheritedFrom !== null)
        fail("LINEAR_RESOURCE_UNSUPPORTED");
      mutation =
        "mutation WorkflowSkillDelete($id: String!) { deleted: agentSkillDelete(id: $id) { success entityId } }";
    } else if (operation === "delete_workflow_template") {
      const existing = await this.template(id, workspace, signal);
      if (!["issue", "document"].includes(existing.type) || existing.inheritedFrom !== null)
        fail("LINEAR_RESOURCE_UNSUPPORTED");
      mutation =
        "mutation WorkflowTemplateDelete($id: String!) { deleted: templateDelete(id: $id) { success entityId } }";
    } else {
      const root = await this.request(
        `query WorkflowDocument($id: String!) { ${VIEWER} document(id: $id) { ${DOCUMENT_FIELDS} } }`,
        { id },
        signal,
      );
      viewer(root, workspace);
      const existing = this.documentRecord(root.document, id, workspace);
      if (existing.trashed === true) fail("LINEAR_RESOURCE_UNSUPPORTED");
      mutation = `mutation WorkflowDocumentDelete($id: String!) { deleted: documentDelete(id: $id) { success entity { ${DOCUMENT_FIELDS} } } }`;
    }
    await this.options.tokenProvider.assertCurrentAuthorization?.();
    const root = await this.request(mutation, { id }, signal, attempt);
    await this.options.tokenProvider.assertCurrentAuthorization?.();
    const deleted = record(root.deleted);
    if (deleted.success !== true) fail("LINEAR_INVALID_RESPONSE");
    if (operation === "delete_document") {
      // The standard archive payload may acknowledge success without returning the deleted entity.
      if (deleted.entity === null) return { id, workspace, success: true };
      const entity = this.documentRecord(deleted.entity, id, workspace);
      if (entity.trashed !== true || !entity.archivedAt) fail("LINEAR_INVALID_RESPONSE");
      return { ...entity, success: true };
    }
    if (deleted.entityId !== id) fail("LINEAR_IDENTITY_MISMATCH");
    return { id, workspace, success: true };
  }
  private async save(
    input: InputRecord,
    workspace: string,
    attempt: Attempt,
    signal?: AbortSignal,
  ): Promise<InputRecord> {
    const teamId = uuid(input.teamId);
    const id = attempt.targetId;
    if (!id) fail("LINEAR_INPUT_INVALID");
    const org = await this.team(teamId, workspace, signal);
    const existing = input.id
      ? await this.skill(id, workspace, signal, { id: teamId, organizationId: org.id })
      : undefined;
    if (existing) {
      organization(record(existing.owner).organization, workspace, org.id);
      if (existing.teamId !== teamId || existing.inheritedFrom !== null)
        fail("LINEAR_IDENTITY_MISMATCH");
    }
    const variables = existing
      ? { id, input: { title: input.title, body: input.body } }
      : { input: { id, teamId, title: input.title, body: input.body } };
    const mutation = existing
      ? `mutation WorkflowSkillUpdate($id: String!, $input: AgentSkillUpdateInput!) { saved: agentSkillUpdate(id: $id, input: $input) { success agentSkill { ${SKILL_FIELDS} } } }`
      : `mutation WorkflowSkillCreate($input: AgentSkillCreateInput!) { saved: agentSkillCreate(input: $input) { success agentSkill { ${SKILL_FIELDS} } } }`;
    const root = await this.request(mutation, variables, signal, attempt);
    const saved = record(root.saved);
    if (saved.success !== true) fail("LINEAR_INVALID_RESPONSE");
    const result = this.skillRecord(saved.agentSkill, workspace, org.id, id, teamId);
    if (
      result.title !== input.title ||
      result.body !== input.body ||
      result.inheritedFrom !== null ||
      (existing &&
        ["icon", "color", "shared", "owner"].some(
          (k) => !isDeepStrictEqual(result[k], existing[k]),
        ))
    )
      fail("LINEAR_SAVED_FIELD_MISMATCH");
    return result;
  }
  private async createTemplate(
    input: InputRecord,
    workspace: string,
    attempt: Attempt,
    signal?: AbortSignal,
  ): Promise<InputRecord> {
    const id = attempt.targetId;
    if (!id) fail("LINEAR_INPUT_INVALID");
    const org = input.teamId
      ? await this.team(uuid(input.teamId), workspace, signal)
      : viewer(
          await this.request(`query WorkflowTemplateScope { ${VIEWER} }`, {}, signal),
          workspace,
        );
    const data = {
      descriptionData: input.descriptionData,
      ...(Object.hasOwn(input, "title") ? { title: input.title } : {}),
      ...(Object.hasOwn(input, "priority") ? { priority: input.priority } : {}),
    };
    const root = await this.request(
      `mutation WorkflowTemplateCreate($input: TemplateCreateInput!) { saved: templateCreate(input: $input) { success template { ${TEMPLATE_FIELDS} } } }`,
      {
        input: {
          id,
          name: input.name,
          type: input.type,
          templateData: JSON.stringify(data),
          ...(input.teamId ? { teamId: input.teamId } : {}),
          ...(Object.hasOwn(input, "description") ? { description: input.description } : {}),
        },
      },
      signal,
      attempt,
    );
    const saved = record(root.saved);
    if (saved.success !== true) fail("LINEAR_INVALID_RESPONSE");
    const result = this.templateRecord(saved.template, workspace, org.id, id);
    let actual: InputRecord;
    try {
      actual = record(JSON.parse(result.templateData));
    } catch {
      fail("LINEAR_INVALID_RESPONSE");
    }
    if (
      result.name !== input.name ||
      result.type !== input.type ||
      result.teamId !== (input.teamId ?? null) ||
      result.inheritedFrom !== null ||
      (Object.hasOwn(input, "description") && result.description !== input.description) ||
      Object.entries(data).some(([key, value]) => !isDeepStrictEqual(actual[key], value))
    )
      fail("LINEAR_SAVED_FIELD_MISMATCH");
    return result;
  }
  private async updateTemplate(
    input: InputRecord,
    workspace: string,
    attempt: Attempt,
    signal?: AbortSignal,
  ): Promise<InputRecord> {
    const id = uuid(input.id);
    const existing = await this.template(id, workspace, signal);
    if (!["issue", "document"].includes(existing.type) || existing.inheritedFrom !== null)
      fail("LINEAR_RESOURCE_UNSUPPORTED");
    let prior: InputRecord;
    try {
      prior = record(JSON.parse(existing.templateData));
    } catch {
      fail("LINEAR_INVALID_RESPONSE");
    }
    const merged = { ...prior, descriptionData: input.descriptionData };
    const update = {
      templateData: JSON.stringify(merged),
      ...(Object.hasOwn(input, "description") ? { description: input.description } : {}),
    };
    const root = await this.request(
      `mutation WorkflowTemplateUpdate($id: String!, $input: TemplateUpdateInput!) { saved: templateUpdate(id: $id, input: $input) { success template { ${TEMPLATE_FIELDS} } } }`,
      { id, input: update },
      signal,
      attempt,
    );
    const saved = record(root.saved);
    if (saved.success !== true) fail("LINEAR_INVALID_RESPONSE");
    const result = this.templateRecord(saved.template, workspace, existing.organization.id, id);
    let actual: InputRecord;
    try {
      actual = record(JSON.parse(result.templateData));
    } catch {
      fail("LINEAR_INVALID_RESPONSE");
    }
    if (
      !isDeepStrictEqual(actual, merged) ||
      result.description !==
        (Object.hasOwn(input, "description") ? input.description : existing.description) ||
      ["type", "name", "team", "inheritedFrom", "icon", "color", "sortOrder"].some(
        (k) => !isDeepStrictEqual(result[k], existing[k]),
      )
    )
      fail("LINEAR_SAVED_FIELD_MISMATCH");
    return result;
  }
}
