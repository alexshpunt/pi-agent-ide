import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-ide/api/resource";
import { GithubApiError } from "./client.ts";
import { GithubRateLimitError, safeRateLimitInfo, type GithubRateLimitInfo } from "./rate-limit.ts";
import { GithubNotSentError } from "./request-coordinator.ts";

/** Fail visibly rather than silently discarding cooldown metadata on an older SDK. */
export function assertGithubMetadataSdk(): void {
  const probe = new ResourceError("GH_RATE_LIMITED", "github://api", "not-applied", {
    metadata: { rateLimit: { retryAfterMs: 1 } },
  });
  if (probe.metadata?.rateLimit?.retryAfterMs !== 1)
    throw new Error(
      "GitHub requires a pi-agent-ide SDK with public ResourceError.metadata support (LPT-912). Update the IDE SDK before enabling GitHub resources.",
    );
}
type Effect = "not-applied" | "unknown";
/** Copy only owned codes/effects and the public allowlisted SDK metadata. Never copy causes. */
export function githubResourceError(
  error: unknown,
  source: string,
  fallback: string,
  effect?: Effect,
): ResourceError {
  if (error instanceof ResourceError || error instanceof GithubApiError) {
    return new ResourceError(error.code, source, effect ?? error.effect, {
      metadata: error.metadata,
    });
  }
  if (error instanceof GithubRateLimitError) {
    return new ResourceError(error.code, source, effect ?? "not-applied", {
      metadata: { rateLimit: error.rateLimit },
    });
  }
  if (error instanceof GithubNotSentError)
    return new ResourceError(error.code, source, effect ?? "not-applied");
  const code =
    error instanceof Error && /^GH_[A-Z_]{1,64}$/u.test(error.message) ? error.message : fallback;
  return new ResourceError(code, source, effect ?? "not-applied");
}

/** Safe presentation is derived from the same metadata supplied to the agent, not upstream text. */
export function githubRateLimitText(value: unknown): string | undefined {
  const info = safeRateLimitInfo(value);
  if (!info) return undefined;
  const parts: string[] = [];
  if (info.retryAfterMs !== undefined)
    parts.push(`Retry after ${Math.ceil(info.retryAfterMs / 1000)} seconds.`);
  if (info.resetAt !== undefined) {
    const date = new Date(info.resetAt);
    parts.push(
      `Cooldown ends at ${Number.isNaN(date.valueOf()) ? info.resetAt : date.toISOString()}.`,
    );
  }
  return parts.length ? parts.join(" ") : undefined;
}

/** Extract only safe public metadata from a failed GitHub result or action receipt. */
export function githubResultRateLimit(details: unknown): GithubRateLimitInfo | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = details as {
    failure?: { cause?: unknown };
    metadata?: { semanticAction?: { kind?: string; metadata?: { rateLimit?: unknown } } };
  };
  const cause = value.failure?.cause;
  if (cause instanceof ResourceError && cause.code.startsWith("GH_"))
    return safeRateLimitInfo(cause.metadata?.rateLimit);
  const action = value.metadata?.semanticAction;
  return action?.kind === "github-failure"
    ? safeRateLimitInfo(action.metadata?.rateLimit)
    : undefined;
}

/** The public hook supplies visible timing and additive metadata without replacing SDK failure codes. */
export function presentGithubRateLimit(event: ToolResultEvent): ToolResultEventResult | undefined {
  const action = (
    event.details as { metadata?: { semanticAction?: { kind?: string; ok?: boolean } } } | undefined
  )?.metadata?.semanticAction;
  if (!event.isError && !(action?.kind === "github-failure" && action.ok === false)) return;
  const info = githubResultRateLimit(event.details);
  const hint = githubRateLimitText(info);
  if (!hint || event.content.some((block) => block.type === "text" && block.text.includes(hint)))
    return;
  let structured = event.structuredContent;
  // Search preserves the ResourceError cause, but older SDK renderers omit its public metadata.
  if (
    info &&
    ["search", "github_search"].includes(event.toolName) &&
    structured &&
    typeof structured === "object" &&
    !Array.isArray(structured) &&
    "status" in structured &&
    structured.status === "error" &&
    "errors" in structured &&
    Array.isArray(structured.errors) &&
    structured.errors.length === 1
  ) {
    const error: unknown = structured.errors[0];
    if (error && typeof error === "object" && !Array.isArray(error))
      structured = { ...structured, errors: [{ ...error, metadata: { rateLimit: { ...info } } }] };
  }
  return {
    isError: true,
    details: event.details,
    content: [...event.content, { type: "text", text: hint }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}
