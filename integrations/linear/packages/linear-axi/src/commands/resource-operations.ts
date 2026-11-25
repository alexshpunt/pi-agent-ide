import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats, { type FormatsPlugin } from "ajv-formats";
import { parseFlags, usage } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import { extractData } from "#axi/lib/mcp-tools.ts";
import { mcpToolFailure } from "#axi/lib/mcp-error.ts";
import {
  ResourceOperationFailure,
  resourceOperationFailure,
  resourceFailureDescription,
} from "#axi/lib/resource-failure.ts";
import {
  isLinearOperation,
  isReadOnlyOperation,
  type LinearOperation,
} from "#axi/lib/operation-catalog.ts";
import { WORKFLOW_OPERATIONS, type WorkflowOperation } from "#axi/native-workflow.ts";
import {
  isRecord,
  isUnknownArray,
  type InputRecord,
  type McpTool,
  type Runtime,
} from "#axi/types.ts";
import { rateLimitInfoFromError, safeRateLimitInfo } from "#axi/rate-limit.ts";

const nativeOperations = new Set<string>(WORKFLOW_OPERATIONS);

function isNativeOperation(operation: string): operation is WorkflowOperation {
  return nativeOperations.has(operation);
}

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
interface AvailableOperation extends McpTool {
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
export type OperationEffect = "applied" | "not-applied" | "unknown";
/** One backend invocation. Data is JSON so nested resources remain lossless in compact TOON. */
export interface OperationReceipt {
  workspace: string;
  operation: LinearOperation;
  effect: OperationEffect;
  data: string;
  error?: string;
  rateLimit?: string;
  /** Generated create UUID or existing target UUID, retained after an uncertain save. */
  targetId?: string;
}

/** Internal provider transport only; it does not register another agent tool family. */
export async function resourceOperationCommand(args: string[], runtime: Runtime): Promise<string> {
  const parsed = parseFlags(args, {
    boolean: ["help"],
    example: "resources capabilities --workspace example",
  });
  if (parsed.help)
    return "usage: linear-axi resources capabilities --workspace <slug>\nusage: linear-axi resources invoke <approved-operation> --workspace <slug> --input-file <local-json-file>\ndescription: Internal provider transport. Reads only approved live schemas, checks workspace and input before invoking a closed-catalog operation. Inputs are at most 2 MiB. Mutation failures after dispatch are unknown and never retried. The caller owns target-specific approval and saved-resource verification.\n";
  const [action, candidateOperation] = parsed.positionals;
  const workspace = parsed.workspace;
  const flags = new Set([
    "positionals",
    "workspace",
    ...(action === "invoke" ? ["input-file"] : []),
  ]);
  if (
    (action !== "capabilities" && action !== "invoke") ||
    parsed.positionals.length !== (action === "invoke" ? 2 : 1) ||
    !Object.keys(parsed).every((key) => flags.has(key)) ||
    typeof workspace !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(workspace)
  )
    throw usage("invalid resource operation");
  let invocation: { operation: LinearOperation; input: InputRecord } | undefined;
  if (action === "invoke") {
    if (!isLinearOperation(candidateOperation)) throw new Error("LINEAR_RESOURCE_UNSUPPORTED");
    // Bounded local input is checked before even a read-only network call.
    invocation = {
      operation: candidateOperation,
      input: await readInput(parsed["input-file"], runtime.cwd),
    };
  }
  const nativeDeleteInvocation =
    invocation !== undefined &&
    isNativeOperation(invocation.operation) &&
    invocation.operation.startsWith("delete_");
  let available: AvailableOperation[];
  try {
    available = await availableOperations(runtime, nativeDeleteInvocation);
  } catch (error) {
    throw resourceOperationFailure("CAPABILITIES", error);
  }
  try {
    // New native Delete operations own their App workspace/target proof; legacy guards stay intact.
    if (!nativeDeleteInvocation) await verifyWorkspace(runtime, workspace);
  } catch (error) {
    throw resourceOperationFailure("WORKSPACE", error);
  }
  if (!invocation) {
    return renderToon({
      capabilities: {
        workspace,
        items: available
          .filter((tool) => isLinearOperation(tool.name))
          .map((tool) => ({
            name: tool.name,
            inputSchema: JSON.stringify(tool.inputSchema),
            annotations: JSON.stringify(tool.annotations ?? {}),
          })),
      },
    });
  }
  const { operation, input } = invocation;
  const tool = available.find((tool) => tool.name === operation);
  if (!tool) throw new Error("LINEAR_RESOURCE_UNSUPPORTED");
  try {
    validateInput(tool.inputSchema, input);
  } catch (error) {
    if (error instanceof Error && error.message === "LINEAR_SCHEMA_INVALID")
      throw resourceOperationFailure("CAPABILITIES", error);
    throw error;
  }
  const receipt: OperationReceipt = {
    workspace,
    operation,
    effect: "not-applied",
    data: "null",
  };
  if (isNativeOperation(operation)) {
    try {
      const client = runtime.searchClient;
      if (!client?.invokeWorkflow) throw new Error("LINEAR_INVALID_RESPONSE");
      const native = await client.invokeWorkflow(operation, input, workspace);
      if (!["applied", "not-applied", "unknown"].includes(native.effect))
        throw new Error("LINEAR_INVALID_RESPONSE");
      receipt.effect = native.effect;
      if (native.targetId) receipt.targetId = native.targetId;
      receipt.data = serializeResult(native.data);
      if (native.error !== undefined) {
        receipt.error = resourceOperationFailure("OPERATION", new Error(native.error)).message;
        const rateLimit = safeRateLimitInfo(native.rateLimit);
        if (rateLimit) receipt.rateLimit = JSON.stringify(rateLimit);
        receipt.data = "null";
        if (isReadOnlyOperation(receipt.operation)) receipt.effect = "not-applied";
      }
    } catch (error) {
      receipt.effect = isReadOnlyOperation(receipt.operation) ? "not-applied" : "unknown";
      receipt.data = "null";
      receipt.error = resourceOperationFailure("OPERATION", error).message;
      const rateLimit = rateLimitInfoFromError(error);
      if (rateLimit) receipt.rateLimit = JSON.stringify(rateLimit);
    }
    return renderOperationReceipt(receipt);
  }
  try {
    const result = await runtime.client.callTool(operation, input);
    if (result.isError) {
      receipt.effect = isReadOnlyOperation(receipt.operation) ? "not-applied" : "unknown";
      const failure = mcpToolFailure("OPERATION", result);
      receipt.error = failure.message;
      if (failure.rateLimit) receipt.rateLimit = JSON.stringify(failure.rateLimit);
    } else {
      receipt.effect = "applied";
      let data = extractData(result);
      if (operation === "get_issue") {
        try {
          data = await enrichIssueEstimate(data, input, workspace, runtime);
        } catch (error) {
          throw resourceOperationFailure("ISSUE_ENRICHMENT", error);
        }
      }
      receipt.data = serializeResult(data);
    }
  } catch (error) {
    const failure = resourceOperationFailure("OPERATION", error);
    // One MCP tools/call request: a connection that never opened sent nothing.
    receipt.effect =
      isReadOnlyOperation(receipt.operation) || failure.reason === "CONNECT_FAILED"
        ? "not-applied"
        : "unknown";
    receipt.error = failure.message;
    const rateLimit = rateLimitInfoFromError(error);
    if (rateLimit) receipt.rateLimit = JSON.stringify(rateLimit);
    receipt.data = "null";
  }
  return renderOperationReceipt(receipt);
}

function stringifyJson(value: unknown): string | undefined {
  return JSON.stringify(value);
}

function serializeResult(value: unknown): string {
  const json = stringifyJson(value);
  if (json === undefined) throw new Error("LINEAR_INVALID_RESPONSE");
  return json;
}

function renderOperationReceipt(receipt: OperationReceipt): string {
  const diagnosis = receipt.error && resourceFailureDescription(receipt.error);
  return renderToon({ invocation: receipt, ...(diagnosis ? { diagnosis } : {}) });
}
// Native App authorization is independent of MCP. Only enrich correlated issue identities.
async function enrichIssueEstimate(
  data: unknown,
  input: InputRecord,
  workspace: string,
  runtime: Runtime,
): Promise<unknown> {
  if (
    !runtime.searchClient?.readIssueEstimate ||
    (isUnknownArray(input.fields) && !input.fields.includes("estimate")) ||
    (isRecord(data) && Object.hasOwn(data, "estimate"))
  )
    return data;
  if (!isRecord(data)) throw new Error("LINEAR_INVALID_RESPONSE");
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  const issueId = data.uuid ?? data.id;
  const identifier = data.identifier ?? data.id;
  if (
    typeof issueId !== "string" ||
    !uuidPattern.test(issueId) ||
    typeof identifier !== "string" ||
    !/^[A-Za-z0-9_]+-[0-9]+$/u.test(identifier)
  )
    throw new Error("LINEAR_INVALID_RESPONSE");
  if (
    (data.id !== identifier && data.id !== issueId) ||
    typeof input.id !== "string" ||
    (input.id !== identifier && input.id.toLowerCase() !== issueId.toLowerCase())
  )
    throw new Error("LINEAR_IDENTITY_MISMATCH");
  const estimate = await runtime.searchClient.readIssueEstimate({ workspace, issueId, identifier });
  if (estimate.id !== issueId.toLowerCase() || estimate.identifier !== identifier)
    throw new Error("LINEAR_IDENTITY_MISMATCH");
  const value: unknown = estimate.estimate;
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value)))
    throw new Error("LINEAR_INVALID_RESPONSE");
  return { ...data, estimate: value };
}
async function availableOperations(
  runtime: Runtime,
  nativeOnly = false,
): Promise<AvailableOperation[]> {
  const tools: unknown = nativeOnly ? [] : await runtime.client.listTools();
  if (!isUnknownArray(tools)) throw new Error("LINEAR_INVALID_RESPONSE");
  const available: AvailableOperation[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (
      !isRecord(tool) ||
      typeof tool.name !== "string" ||
      !isLinearOperation(tool.name) ||
      isNativeOperation(tool.name)
    )
      continue;
    const { name, inputSchema, annotations } = tool;
    if (seen.has(name) || !isRecord(inputSchema)) throw new Error("LINEAR_SCHEMA_INVALID");
    if (annotations !== undefined && !isRecord(annotations))
      throw new Error("LINEAR_SCHEMA_INVALID");
    available.push({ name, inputSchema, annotations });
    seen.add(name);
  }
  if (runtime.searchClient?.workflowCapabilities && runtime.searchClient.invokeWorkflow) {
    for (const tool of runtime.searchClient.workflowCapabilities()) {
      if (!nativeOperations.has(tool.name) || !isRecord(tool.inputSchema) || seen.has(tool.name))
        throw new Error("LINEAR_SCHEMA_INVALID");
      available.push(tool);
      seen.add(tool.name);
    }
  }
  return available.sort((a, b) => a.name.localeCompare(b.name));
}

/** Verify the selected MCP workspace; reuse only successful connection-scoped proof. */
export async function verifyWorkspace(runtime: Runtime, workspace: string): Promise<void> {
  const verify = async (): Promise<true> => {
    const result = await runtime.client.callTool("get_workspace", {});
    if (result.isError) throw mcpToolFailure("WORKSPACE", result);
    const value = extractData(result);
    if (!isRecord(value)) throw new ResourceOperationFailure("WORKSPACE", "INVALID_RESPONSE");
    if (value.url !== `https://linear.app/${workspace}`)
      throw new ResourceOperationFailure("WORKSPACE", "IDENTITY_MISMATCH");
    return true;
  };
  if (runtime.preflightCache)
    await runtime.preflightCache.get(
      "workspace:" + workspace,
      verify,
      (value): value is true => value === true,
    );
  else await verify();
}

export async function readInput(filename: unknown, cwd: string): Promise<InputRecord> {
  if (typeof filename !== "string" || !filename || filename.includes("://"))
    throw new Error("LINEAR_INPUT_INVALID");
  let file: FileHandle | undefined;
  try {
    file = await open(
      path.resolve(cwd, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    if (!info.isFile()) throw new Error("LINEAR_INPUT_INVALID");
    if (info.size > MAX_INPUT_BYTES) throw new Error("LINEAR_INPUT_TOO_LARGE");
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      size += bytesRead;
      if (size > MAX_INPUT_BYTES) throw new Error("LINEAR_INPUT_TOO_LARGE");
      if (!bytesRead) break;
    }
    const input: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)),
    );
    if (!isRecord(input)) throw new Error("LINEAR_INPUT_INVALID");
    return input;
  } catch (error) {
    if (error instanceof Error && error.message === "LINEAR_INPUT_TOO_LARGE") throw error;
    throw new Error("LINEAR_INPUT_INVALID", { cause: error });
  } finally {
    await file?.close();
  }
}

// Omitted additionalProperties must not silently accept invented fields. Explicit map schemas stay open.
function closeNamedObjects(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const closed = { ...schema };
  if (isRecord(schema.properties) && schema.additionalProperties === undefined)
    closed.additionalProperties = false;
  for (const key of ["properties", "patternProperties", "$defs", "definitions"]) {
    const nested = schema[key];
    if (isRecord(nested))
      closed[key] = Object.fromEntries(
        Object.entries(nested).map(([name, value]) => [name, closeNamedObjects(value)]),
      );
  }
  for (const key of [
    "items",
    "additionalProperties",
    "unevaluatedProperties",
    "contains",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ])
    if (isRecord(schema[key])) closed[key] = closeNamedObjects(schema[key]);
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const alternatives = schema[key];
    if (isUnknownArray(alternatives)) closed[key] = alternatives.map(closeNamedObjects);
  }
  return closed;
}
// Node's CommonJS default is a callable plugin even though NodeNext resolves its namespace type.
function installFormats(plugin: unknown, ajv: Ajv | Ajv2020): void {
  if (typeof plugin !== "function") throw new Error("LINEAR_SCHEMA_INVALID");
  (plugin as FormatsPlugin)(ajv);
}

function validateInput(schema: Record<string, unknown>, input: InputRecord): void {
  const properties = schema.properties ?? {};
  if (schema.type !== "object" || !isRecord(properties)) throw new Error("LINEAR_SCHEMA_INVALID");
  if (Object.keys(input).some((key) => !Object.hasOwn(properties, key)))
    throw new Error("LINEAR_INPUT_INVALID");
  // Some published schemas omit minLength on identities; empty targets never authorize a call.
  if (
    Object.entries(input).some(
      ([key, value]) =>
        /^(?:id|query|issue|project|team|user|diff|release|template|milestone|parentId|[A-Za-z]+Id)$/u.test(
          key,
        ) &&
        typeof value === "string" &&
        !value.trim(),
    )
  )
    throw new Error("LINEAR_INPUT_INVALID");
  let validate: ValidateFunction;
  try {
    const options = {
      strictSchema: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      logger: false as const,
    };
    const ajv =
      typeof schema.$schema === "string" && schema.$schema.includes("2020-12")
        ? new Ajv2020(options)
        : new Ajv(options);
    installFormats(formats, ajv);
    const closed = closeNamedObjects(schema);
    if (!isRecord(closed)) throw new Error("LINEAR_SCHEMA_INVALID");
    validate = ajv.compile(closed);
    if ("$async" in validate && validate.$async === true) throw new Error("LINEAR_SCHEMA_INVALID");
  } catch {
    throw new Error("LINEAR_SCHEMA_INVALID");
  }
  if (!validate(input)) throw new Error("LINEAR_INPUT_INVALID");
}
