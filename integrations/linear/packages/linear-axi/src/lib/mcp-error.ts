import {
  ResourceOperationFailure,
  type ResourceFailureReason,
  type ResourceFailureStage,
} from "./resource-failure.ts";
import { safeRateLimitInfo } from "#axi/rate-limit.ts";
import { asArrayOfUnknown, asRecord } from "#axi/types.ts";

const codes = new Map<string, ResourceFailureReason>([
  ["UNAUTHENTICATED", "AUTH_REQUIRED"],
  ["UNAUTHORIZED", "AUTH_REQUIRED"],
  ["AUTHENTICATION_ERROR", "AUTH_REQUIRED"],
  ["invalid_token", "AUTH_REQUIRED"],
  ["invalid_grant", "AUTH_REQUIRED"],
  ["FORBIDDEN", "PERMISSION_DENIED"],
  ["PERMISSION_DENIED", "PERMISSION_DENIED"],
  ["INSUFFICIENT_SCOPE", "PERMISSION_DENIED"],
  ["insufficient_scope", "PERMISSION_DENIED"],
  ["RATELIMITED", "RATE_LIMITED"],
  ["RATE_LIMITED", "RATE_LIMITED"],
  ["TOO_MANY_REQUESTS", "RATE_LIMITED"],
  ["BAD_USER_INPUT", "VALIDATION_FAILED"],
  ["INVALID_INPUT", "VALIDATION_FAILED"],
  ["INVALID_ARGUMENT", "VALIDATION_FAILED"],
  ["VALIDATION_ERROR", "VALIDATION_FAILED"],
  ["GRAPHQL_VALIDATION_FAILED", "VALIDATION_FAILED"],
  ["invalid_request", "VALIDATION_FAILED"],
  ["invalid_params", "VALIDATION_FAILED"],
]);
const statuses = new Map<number, ResourceFailureReason>([
  [400, "VALIDATION_FAILED"],
  [401, "AUTH_REQUIRED"],
  [403, "PERMISSION_DENIED"],
  [408, "TIMEOUT"],
  [422, "VALIDATION_FAILED"],
  [429, "RATE_LIMITED"],
]);

/** Decode only protocol fields from an MCP error result, never infer causes from prose. */
export function mcpToolFailure(
  stage: ResourceFailureStage,
  result: unknown,
): ResourceOperationFailure {
  const response = asRecord(result);
  if (response?.isError !== true) return new ResourceOperationFailure(stage, "BACKEND_REJECTED");
  let value = response.structuredContent;
  const content = asArrayOfUnknown(response.content);
  if (value === undefined && content?.length === 1) {
    const item = asRecord(content[0]);
    const text = item?.type === "text" ? item.text : undefined;
    if (typeof text === "string" && text.length <= 64 * 1024) {
      try {
        value = JSON.parse(text);
      } catch {
        /* Unstructured backend messages remain private. */
      }
    }
  }
  const data = asRecord(value);
  if (!data) return new ResourceOperationFailure(stage, "BACKEND_REJECTED");
  // Keep the previously supported exact Linear missing-issue envelope specific.
  if (
    data.error === "invalid_request" &&
    data.status === 400 &&
    data.message === "Could not find referenced Issue."
  )
    return new ResourceOperationFailure(stage, "ISSUE_NOT_FOUND");
  const error = asRecord(data.error);
  const candidates = [
    data,
    ...(error ? [error] : []),
    ...(asArrayOfUnknown(data.errors)?.slice(0, 16) ?? []),
  ];
  for (const candidate of candidates) {
    const status = asRecord(candidate)?.status;
    const reason = typeof status === "number" ? statuses.get(status) : undefined;
    if (reason && status !== 400 && status !== 422)
      return new ResourceOperationFailure(
        stage,
        reason,
        safeRateLimitInfo(asRecord(candidate)?.rateLimit ?? data.rateLimit),
      );
  }
  for (const candidate of candidates) {
    const item = asRecord(candidate);
    if (!item) continue;
    for (const code of [item.code, item.error, asRecord(item.extensions)?.code]) {
      const reason = typeof code === "string" ? codes.get(code) : undefined;
      if (reason)
        return new ResourceOperationFailure(
          stage,
          reason,
          safeRateLimitInfo(item.rateLimit ?? data.rateLimit),
        );
    }
  }
  for (const candidate of candidates) {
    const status = asRecord(candidate)?.status;
    const reason = typeof status === "number" ? statuses.get(status) : undefined;
    if (reason)
      return new ResourceOperationFailure(
        stage,
        reason,
        safeRateLimitInfo(asRecord(candidate)?.rateLimit ?? data.rateLimit),
      );
  }
  return new ResourceOperationFailure(stage, "BACKEND_REJECTED");
}
