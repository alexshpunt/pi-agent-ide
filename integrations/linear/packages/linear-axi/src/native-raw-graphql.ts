import {
  getOperationAST,
  Kind,
  parse,
  type DocumentNode,
  type OperationDefinitionNode,
} from "graphql";
import { isRecord, isUnknownArray } from "./types.ts";
import { authorizationHeader, type NativeTokenProvider } from "./app-token.ts";
import { isConnectionFailure } from "./lib/connection-failure.ts";
import {
  LinearRateLimitError,
  rateLimitInfoFromHeaders,
  safeRateLimitInfo,
  type RateLimitInfo,
  type RateLimitObserver,
} from "./rate-limit.ts";

const endpoint = "https://api.linear.app/graphql";
const maximumBytes = 2 * 1024 * 1024;
const scopeQuery = "query RawGraphqlWorkspace { viewer { organization { id urlKey } } }";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export interface RawGraphqlRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}
export interface RawGraphqlReceipt {
  workspace: string;
  operationType: "query" | "mutation";
  operationName?: string;
  status: number | null;
  effect: "applied" | "not-applied" | "unknown";
  ok: boolean;
  outcome: "success" | "partial" | "error" | "unknown";
  data?: unknown;
  errors?: unknown[];
  extensions?: unknown;
  error?: string;
  rateLimit?: RateLimitInfo;
}
/** Invalid request documents and local input files have never been dispatched. */
export class RawGraphqlInputError extends Error {
  readonly effect = "not-applied";
  constructor(code = "LINEAR_GRAPHQL_INPUT_INVALID") {
    super(code);
  }
}
function invalid(): never {
  throw new RawGraphqlInputError();
}

/** Parse executable GraphQL before authorization; operation names never form an API allowlist. */
export function validateRawGraphqlRequest(value: unknown): {
  request: RawGraphqlRequest;
  operationType: "query" | "mutation";
} {
  if (
    !isRecord(value) ||
    Object.keys(value).some((k) => !["query", "variables", "operationName"].includes(k)) ||
    typeof value.query !== "string" ||
    !value.query.trim() ||
    (value.variables !== undefined && !isRecord(value.variables)) ||
    (value.operationName !== undefined &&
      (typeof value.operationName !== "string" ||
        value.operationName.length > 256 ||
        !/^[_A-Za-z][_0-9A-Za-z]*$/u.test(value.operationName)))
  )
    invalid();
  let request: RawGraphqlRequest;
  let document: DocumentNode;
  try {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, "utf8") > maximumBytes) invalid();
    const plain: unknown = JSON.parse(json);
    if (
      !isRecord(plain) ||
      typeof plain.query !== "string" ||
      (plain.variables !== undefined && !isRecord(plain.variables)) ||
      (plain.operationName !== undefined && typeof plain.operationName !== "string")
    )
      invalid();
    request = {
      query: plain.query,
      ...(plain.variables === undefined ? {} : { variables: plain.variables }),
      ...(plain.operationName === undefined ? {} : { operationName: plain.operationName }),
    };
    document = parse(request.query, { maxTokens: 10000, noLocation: true });
  } catch {
    invalid();
  }
  const operations: OperationDefinitionNode[] = [];
  const names = new Set<string>();
  const fragments = new Set<string>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      if (definition.name) {
        if (names.has(definition.name.value)) invalid();
        names.add(definition.name.value);
      }
      operations.push(definition);
    } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      if (fragments.has(definition.name.value)) invalid();
      fragments.add(definition.name.value);
    } else invalid();
  }
  if (!operations.length || (operations.length > 1 && operations.some((o) => !o.name))) invalid();
  const selected = getOperationAST(document, request.operationName);
  if (!selected || (selected.operation !== "query" && selected.operation !== "mutation")) invalid();
  return { request, operationType: selected.operation };
}

class TransportFailure extends Error {}
function failure(code: string): never {
  throw new TransportFailure(code);
}
/** Awaiting a provider or synthetic stream must obey the same deadline as fetch. */
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}
async function readJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/u.test(length) && Number(length) > maximumBytes)
    failure("LINEAR_GRAPHQL_RESPONSE_TOO_LARGE");
  if (!response.body) failure("LINEAR_GRAPHQL_INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await bounded(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) failure("LINEAR_GRAPHQL_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
    } catch {
      failure("LINEAR_GRAPHQL_INVALID_RESPONSE");
    }
    if (
      !isRecord(payload) ||
      (!Object.hasOwn(payload, "data") && !Object.hasOwn(payload, "errors")) ||
      (Object.hasOwn(payload, "data") && payload.data !== null && !isRecord(payload.data)) ||
      (Object.hasOwn(payload, "errors") &&
        (!isUnknownArray(payload.errors) ||
          payload.errors.some((e) => !isRecord(e) || typeof e.message !== "string")))
    )
      failure("LINEAR_GRAPHQL_INVALID_RESPONSE");
    return payload;
  } finally {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* An aborted synthetic read may still be pending. */
    }
  }
}
/** Exact transport credentials cannot survive in arbitrary JSON values or object keys. */
function redact(payload: Record<string, unknown>, authorization: string): Record<string, unknown> {
  let json = JSON.stringify(payload);
  const secrets = [
    ...new Set([
      authorization,
      authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization,
    ]),
  ];
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    json = json.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
  const result: unknown = JSON.parse(json);
  if (!isRecord(result)) failure("LINEAR_GRAPHQL_INVALID_RESPONSE");
  return result;
}
function responseError(payload: Record<string, unknown>): string {
  const codes = isUnknownArray(payload.errors)
    ? payload.errors.map((e) =>
        isRecord(e) && isRecord(e.extensions) ? e.extensions.code : undefined,
      )
    : [];
  if (codes.some((c) => c === "RATE_LIMITED" || c === "RATELIMITED")) return "LINEAR_RATE_LIMITED";
  if (codes.includes("FORBIDDEN")) return "LINEAR_PERMISSION_DENIED";
  if (codes.includes("UNAUTHENTICATED")) return "LINEAR_GRAPHQL_AUTH_REQUIRED";
  return "LINEAR_GRAPHQL_FAILED";
}

interface NativeRawGraphqlOptions {
  tokenProvider: NativeTokenProvider;
  fetchImpl?: typeof fetch;
  onRateLimit?: RateLimitObserver;
  /** Test clocks may shorten, never extend, the production whole-call deadline. */
  timeoutMs?: number;
}
/** One native request under the selected identity. Raw mutation failures are never replayed. */
export class NativeRawGraphqlClient {
  private readonly options: NativeRawGraphqlOptions;
  constructor(options: NativeRawGraphqlOptions) {
    this.options = options;
  }

  async execute(
    value: unknown,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<RawGraphqlReceipt> {
    const { request, operationType } = validateRawGraphqlRequest(value);
    if (!/^[A-Za-z0-9_-]+$/u.test(workspace)) invalid();
    const timeout = this.options.timeoutMs ?? 30000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) invalid();
    const deadline = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    const receipt: RawGraphqlReceipt = {
      workspace,
      operationType,
      ...(request.operationName ? { operationName: request.operationName } : {}),
      status: null,
      effect: "not-applied",
      ok: false,
      outcome: "error",
    };
    const dispatch = { attempted: false };
    let authorization = "";
    try {
      deadline.throwIfAborted();
      authorization = await bounded(authorizationHeader(this.options.tokenProvider), deadline);
      if (!authorization || /[\r\n]/u.test(authorization)) failure("LINEAR_GRAPHQL_AUTH_REQUIRED");
      const assertCurrent = async () => {
        if (this.options.tokenProvider.assertCurrentAuthorization)
          await bounded(this.options.tokenProvider.assertCurrentAuthorization(), deadline);
        deadline.throwIfAborted();
      };
      const send = async (body: unknown, raw = false): Promise<Response> => {
        await assertCurrent();
        if (raw) dispatch.attempted = true;
        const response = await bounded(
          (this.options.fetchImpl ?? fetch)(endpoint, {
            method: "POST",
            headers: { authorization, "content-type": "application/json" },
            body: JSON.stringify(body),
            redirect: "error",
            signal: deadline,
          }),
          deadline,
        );
        await assertCurrent();
        return response;
      };
      const scope = await send({ query: scopeQuery });
      if (scope.status === 401) failure("LINEAR_GRAPHQL_AUTH_REQUIRED");
      if (scope.status === 403) failure("LINEAR_PERMISSION_DENIED");
      if (scope.status === 429)
        throw new LinearRateLimitError(rateLimitInfoFromHeaders(scope.headers, Date.now(), true));
      const scopePayload = await readJson(scope, deadline);
      if (!scope.ok || (isUnknownArray(scopePayload.errors) && scopePayload.errors.length))
        failure(responseError(scopePayload));
      const viewer = isRecord(scopePayload.data) && scopePayload.data.viewer;
      const org = isRecord(viewer) && viewer.organization;
      if (
        !isRecord(org) ||
        typeof org.id !== "string" ||
        !uuid.test(org.id) ||
        org.urlKey !== workspace
      )
        failure("LINEAR_IDENTITY_MISMATCH");
      deadline.throwIfAborted();
      const response = await send(request, true);
      receipt.status = response.status;
      if (response.status === 429)
        receipt.rateLimit = safeRateLimitInfo(
          rateLimitInfoFromHeaders(response.headers, Date.now(), true),
        );
      const payload = redact(await readJson(response, deadline), authorization);
      await assertCurrent();
      if (Object.hasOwn(payload, "data")) receipt.data = payload.data;
      const errorList = isUnknownArray(payload.errors) ? payload.errors : undefined;
      if (errorList !== undefined) receipt.errors = errorList;
      if (Object.hasOwn(payload, "extensions")) receipt.extensions = payload.extensions;
      const errors = errorList !== undefined && errorList.length > 0;
      const limited =
        response.status === 429 || (errors && responseError(payload) === "LINEAR_RATE_LIMITED");
      if (limited) {
        receipt.rateLimit = safeRateLimitInfo(
          rateLimitInfoFromHeaders(response.headers, Date.now(), true),
        );
        if (this.options.onRateLimit) {
          try {
            await bounded(this.options.onRateLimit(response.headers), deadline);
          } catch (error) {
            if (!(error instanceof LinearRateLimitError)) throw error;
          }
        }
      }
      await assertCurrent();
      const refused =
        [401, 403, 429].includes(response.status) &&
        !Object.hasOwn(payload, "data") &&
        errors &&
        errorList.every((error) => isRecord(error) && !Object.hasOwn(error, "path"));
      receipt.ok = response.ok && !errors && Object.hasOwn(payload, "data");
      receipt.effect =
        operationType === "query" || refused ? "not-applied" : receipt.ok ? "applied" : "unknown";
      receipt.outcome = receipt.ok
        ? "success"
        : errors && payload.data != null
          ? "partial"
          : receipt.effect === "unknown"
            ? "unknown"
            : "error";
      if (!receipt.ok)
        receipt.error =
          response.status === 401
            ? "LINEAR_GRAPHQL_AUTH_REQUIRED"
            : response.status === 403
              ? "LINEAR_PERMISSION_DENIED"
              : limited
                ? "LINEAR_RATE_LIMITED"
                : responseError(payload);
      return receipt;
    } catch (error) {
      receipt.effect =
        dispatch.attempted && operationType === "mutation" ? "unknown" : "not-applied";
      receipt.outcome = receipt.effect === "unknown" ? "unknown" : "error";
      if (isConnectionFailure(error)) {
        receipt.error = error.message;
        delete receipt.data;
        delete receipt.errors;
        delete receipt.extensions;
      } else if (error instanceof LinearRateLimitError) {
        receipt.error = "LINEAR_RATE_LIMITED";
        receipt.rateLimit = safeRateLimitInfo(error.rateLimit);
      } else if (deadline.aborted)
        receipt.error = signal?.aborted ? "LINEAR_GRAPHQL_CANCELLED" : "LINEAR_GRAPHQL_TIMEOUT";
      else
        receipt.error =
          error instanceof TransportFailure
            ? error.message
            : authorization
              ? "LINEAR_GRAPHQL_FAILED"
              : "LINEAR_GRAPHQL_AUTH_REQUIRED";
      return receipt;
    } finally {
      const rateLimit = receipt.rateLimit;
      const endpointName = rateLimit?.endpoint;
      const secrets = [
        authorization,
        authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization,
      ];
      if (
        rateLimit &&
        endpointName &&
        secrets.some((secret) => secret && endpointName.includes(secret))
      ) {
        delete rateLimit.endpoint;
        if (!Object.keys(rateLimit).length) delete receipt.rateLimit;
      }
    }
  }
}
