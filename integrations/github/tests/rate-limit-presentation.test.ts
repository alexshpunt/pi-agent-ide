import { expect, test } from "vitest";
import { ResourceError } from "pi-agent-ide/api/resource";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { presentGithubRateLimit } from "#github/resource-error.ts";

const resetAt = Date.UTC(2030, 0, 1);
const rateLimit = { retryAfterMs: 60_000, resetAt, requestsRemaining: 0, endpoint: "core" };
test.each(["read", "semantic-action"])(
  "%s exposes numeric retry timing to visible content without changing structured results",
  (kind) => {
    const structuredContent = {
      status: "error",
      errors: [{ code: "GH_RATE_LIMITED", metadata: { rateLimit } }],
    };
    const details =
      kind === "read"
        ? {
            failure: {
              cause: new ResourceError("GH_RATE_LIMITED", "github://o/r/issues/1", "not-applied", {
                metadata: { rateLimit },
              }),
            },
          }
        : {
            metadata: {
              semanticAction: {
                kind: "github-failure",
                ok: false,
                effect: "unknown",
                metadata: { rateLimit },
              },
            },
          };
    const event = {
      type: "tool_result",
      toolName: "read",
      toolCallId: "fixture",
      input: { path: "github://o/r/issues/1" },
      content: [{ type: "text", text: "GH_RATE_LIMITED" }],
      details,
      structuredContent,
      isError: true,
    } as ToolResultEvent;
    const result = presentGithubRateLimit(event);
    if (!result?.content) throw new Error("Expected a rendered rate limit");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBe(structuredContent);
    expect(result.details).toBe(details);
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(text).toContain("60");
    expect(text).toContain(new Date(resetAt).toISOString());
    expect(text).not.toContain("upstream-private-payload");
    expect(presentGithubRateLimit({ ...event, content: result.content })).toBeUndefined();
  },
);
test("Search keeps its owning SDK error code while exposing public rate metadata", () => {
  const event = {
    type: "tool_result",
    toolName: "search",
    toolCallId: "fixture",
    input: { path: "github://o/r", query: "bug" },
    isError: true,
    content: [{ type: "text", text: "GH_RATE_LIMITED" }],
    details: {
      failure: {
        cause: new ResourceError("GH_RATE_LIMITED", "github://o/r", "not-applied", {
          metadata: { rateLimit },
        }),
      },
    },
    structuredContent: {
      status: "error",
      errors: [{ code: "RESOLVE_FAILED", message: "GH_RATE_LIMITED" }],
    },
  } as ToolResultEvent;
  const result = presentGithubRateLimit(event);
  if (!result) throw new Error("Expected a rendered rate limit");
  expect(result.structuredContent).toMatchObject({
    status: "error",
    errors: [{ code: "RESOLVE_FAILED", metadata: { rateLimit } }],
  });
});
test("other providers and healthy GitHub results are not rewritten", () => {
  for (const details of [
    {},
    {
      failure: {
        cause: new ResourceError("OTHER_LIMIT", "other://x", "not-applied", {
          metadata: { rateLimit },
        }),
      },
    },
  ]) {
    expect(
      presentGithubRateLimit({
        type: "tool_result",
        toolName: "read",
        toolCallId: "fixture",
        input: {},
        details,
        isError: true,
        content: [],
      }),
    ).toBeUndefined();
  }
});
