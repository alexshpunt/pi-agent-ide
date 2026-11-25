import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-ide/api/resource";
import { linearOperationRoute } from "./operation-routes.ts";
import {
  axiTimeout,
  linearErrorRateLimit,
  linearFailureReasons as reasons,
  parseLinearResourceFailure,
  type LinearFailureStage,
} from "./resource-failure.ts";

const stages = {
  CAPABILITIES: "fetching the available operations",
  WORKSPACE: "checking the workspace",
  OPERATION: "requesting the resource",
  ISSUE_ENRICHMENT: "reading additional issue fields",
} satisfies Record<LinearFailureStage, string>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
type JsonValue = NonNullable<ToolResultEventResult["structuredContent"]> | null;
type JsonObject = { readonly [key: string]: JsonValue };

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function readSource(source: string): { operation?: string } | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return;
  }
  if (url.username || url.password || url.port) return;
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol === "linear:") {
    if (!/^[A-Za-z0-9_-]+$/u.test(url.hostname)) return;
  } else if (url.protocol === "https:" && url.hostname === "linear.app") {
    if (!/^[A-Za-z0-9_-]+$/u.test(parts.shift() ?? "")) return;
  } else return;
  return { operation: linearOperationRoute(parts[0] ?? "", "read")?.operation };
}
function explanation(code: string, operation?: string): string | undefined {
  const label = operation ? `Linear ${operation}` : "Linear read";
  const failure = parseLinearResourceFailure(code);
  if (failure)
    return `${label} failed while ${stages[failure.stage]}. ${reasons[failure.reason]} ${
      failure.reason === "CONNECT_FAILED"
        ? "The read was not sent; it is safe to retry."
        : "Do not retry automatically."
    }`;
  if (code === "LINEAR_FIELD_NOT_EXPOSED")
    return `${label} did not expose the requested field. Its value is unknown; do not treat it as null.`;
  if (code === "LINEAR_FIELD_UNSUPPORTED")
    return `${label} does not advertise the requested field in the selected backend's schema.`;
  if (code === "LINEAR_INVALID_RESPONSE")
    return `${label} returned invalid resource data. No field value can be inferred.`;
  if (code === "LINEAR_RATE_LIMITED")
    return `${label} failed. ${reasons.RATE_LIMITED} Do not retry automatically.`;
  if (code === "LINEAR_AXI_TIMEOUT")
    return `${label} failed. ${axiTimeout} Do not retry automatically.`;
  if (["LINEAR_RESOURCE_FAILED", "LINEAR_OPERATION_FAILED", "LINEAR_AXI_FAILED"].includes(code))
    return `${label} failed. The backend did not provide a safe stage or cause. Do not retry automatically.`;
}

/** Add only allowlisted AXI diagnoses after shared Read sanitizes provider exceptions. */
export function connectLinearReadErrorGuidance(pi: ExtensionAPI): void {
  pi.on("tool_result", (event): ToolResultEventResult | undefined => {
    if (event.toolName !== "read" || !event.isError) return;
    const failure = record(record(event.details)?.failure);
    const cause = failure?.cause;
    if (!(cause instanceof ResourceError)) return;
    const source = typeof failure?.source === "string" ? failure.source : cause.source;
    const target = readSource(source);
    if (!target) return;
    const explanationText = explanation(cause.code, target.operation);
    if (!explanationText) return;
    const limited =
      cause.code === "LINEAR_RATE_LIMITED" ||
      parseLinearResourceFailure(cause.code)?.reason === "RATE_LIMITED";
    const rateLimit = limited ? linearErrorRateLimit(cause) : undefined;
    const timing: string[] = [];
    if (rateLimit?.retryAfterMs !== undefined)
      timing.push(`Retry delay: ${Math.ceil(rateLimit.retryAfterMs / 1000)} seconds.`);
    if (rateLimit?.resetAt !== undefined) {
      const reset = new Date(rateLimit.resetAt);
      timing.push(
        `Cooldown reset: ${Number.isFinite(reset.getTime()) ? reset.toISOString() : rateLimit.resetAt}.`,
      );
    }
    const hint = [explanationText, ...timing].join(" ");
    const structured = event.structuredContent;
    const errors = isJsonObject(structured) ? structured.errors : undefined;
    return {
      content: [{ type: "text" as const, text: hint }, ...event.content],
      ...(isJsonObject(structured) && isJsonArray(errors)
        ? {
            structuredContent: {
              ...structured,
              errors: errors.map((value) => {
                const error = isJsonObject(value) ? value : undefined;
                if (error?.code !== cause.code) return value;
                const {
                  rateLimit: _untrustedRate,
                  metadata: _untrustedMetadata,
                  ...fields
                } = error;
                return {
                  ...fields,
                  message: `${typeof error.message === "string" ? error.message : cause.code}\n${hint}`,
                  ...(rateLimit ? { metadata: { rateLimit } } : {}),
                };
              }),
            },
          }
        : {}),
    };
  });
}
