import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-ide/api/resource";
import { expect, test } from "vitest";
import { connectLinearReadErrorGuidance } from "#linear/read-error-guidance.ts";

const source = "linear://example/issue/ENG-851";
type ResultHook = ExtensionHandler<ToolResultEvent, ToolResultEventResult>;

function hook(): ResultHook {
  let captured: ResultHook | undefined;
  connectLinearReadErrorGuidance({
    on(name: string, handler: ResultHook) {
      if (name === "tool_result") captured = handler;
      return () => {};
    },
  } as ExtensionAPI);
  if (!captured) throw new Error("Missing Read result hook");
  return captured;
}

const unusedContext = {} as ExtensionContext;
function failure(code: string, path = source) {
  return {
    type: "tool_result" as const,
    toolCallId: "fixture-read",
    input: { path },
    toolName: "read",
    isError: true,
    content: [{ type: "text" as const, text: `${code}: ${path}` }],
    details: { failure: { source: path, cause: new ResourceError(code, path, "not-applied") } },
    structuredContent: { status: "error", errors: [{ code, source: path, message: code }] },
  };
}

async function diagnosed(event: ToolResultEvent) {
  const result = await hook()(event, unusedContext);
  const text = result?.content?.flatMap((item) => (item.type === "text" ? [item.text] : []));
  const structured = result?.structuredContent;
  if (!text || !structured || typeof structured !== "object" || Array.isArray(structured))
    throw new Error("Missing safe structured Read diagnosis");
  const fields = structured as Record<string, unknown>;
  const errors: readonly unknown[] = Array.isArray(fields.errors) ? fields.errors : [];
  const firstError = errors[0];
  if (
    !firstError ||
    typeof firstError !== "object" ||
    Array.isArray(firstError) ||
    !("message" in firstError) ||
    typeof firstError.message !== "string"
  )
    throw new Error("Missing structured Read error");
  return { text, structured: fields, firstError };
}

test.each([
  ["LINEAR_CAPABILITIES_RATE_LIMITED", "fetching the available operations", "rate-limited"],
  ["LINEAR_WORKSPACE_AUTH_REQUIRED", "checking the workspace", "authorization"],
  ["LINEAR_OPERATION_TIMEOUT", "requesting the resource", "timed out"],
  ["LINEAR_ISSUE_ENRICHMENT_PERMISSION_DENIED", "additional issue fields", "denied access"],
  ["LINEAR_OPERATION_BACKEND_REJECTED", "requesting the resource", "cause is unknown"],
  ["LINEAR_OPERATION_UNKNOWN", "requesting the resource", "recognized safe cause"],
  ["LINEAR_OPERATION_NATIVE_UNAVAILABLE", "requesting the resource", "native API"],
  ["LINEAR_OPERATION_STORAGE_UNAVAILABLE", "requesting the resource", "private files"],
  ["LINEAR_OPERATION_CONNECTION_REMOVED", "requesting the resource", "removed"],
])(
  "a safe diagnosis reaches visible and structured Read output: %s",
  async (code, stage, reason) => {
    const event = failure(code);
    event.details.failure.cause.message += " private bearer token and response body";
    const result = await diagnosed(event);
    const text = result.text.join("\n");
    expect(text).toContain("get_issue");
    expect(text).toContain(stage);
    expect(text).toContain(reason);
    expect(text).not.toContain("private bearer");
    expect(result.structured.status).toBe("error");
    expect(result.firstError).toMatchObject({ code, source });
    expect(result.firstError.message).toContain(reason);
    expect(event.content).toHaveLength(1);
    expect(event.details.failure.cause.effect).toBe("not-applied");
  },
);

test("a connection that never opened is named and marked safe to retry", async () => {
  const text = (await diagnosed(failure("LINEAR_OPERATION_CONNECT_FAILED"))).text[0];
  expect(text).toContain("Could not open a connection to Linear.");
  expect(text).toContain("The read was not sent; it is safe to retry.");
  expect(text).not.toContain("Do not retry automatically");
});
test("a local AXI deadline is distinguished from a Linear failure", async () => {
  const text = (await diagnosed(failure("LINEAR_AXI_TIMEOUT"))).text[0];
  expect(text).toContain("local linear-axi process did not finish in time");
  expect(text).toContain("Do not retry automatically");
});

test("the useful diagnosis stays ahead of generic guidance on a failed read", async () => {
  const event = failure("LINEAR_OPERATION_RATE_LIMITED");
  event.content.push({ type: "text", text: "Generic Read guide\n".repeat(40) });
  const result = await diagnosed(event);
  expect(result.text[0]).toContain("rate-limited");
  expect(result.text[1]).toContain("LINEAR_OPERATION_RATE_LIMITED");
});
test("an old generic backend failure admits that both stage and cause are unavailable", async () => {
  const result = await diagnosed(failure("LINEAR_RESOURCE_FAILED"));
  expect(result.text[0]).toContain("did not provide a safe stage or cause");
  expect(result.text[0]).not.toMatch(/authorization|connection failed|rate-limited/u);
});

test("success, foreign providers, error-shaped objects and unknown code suffixes keep their output", async () => {
  const apply = hook();
  const event = failure("LINEAR_OPERATION_UNKNOWN");
  expect(await apply({ ...event, isError: false }, unusedContext)).toBeUndefined();
  expect(
    await apply(
      failure("LINEAR_OPERATION_UNKNOWN", "https://example.org/issue/ENG-851"),
      unusedContext,
    ),
  ).toBeUndefined();
  expect(await apply(failure("LINEAR_OPERATION_PRIVATE_TOKEN"), unusedContext)).toBeUndefined();
  expect(
    await apply(
      {
        ...event,
        details: { failure: { source, cause: { code: "LINEAR_OPERATION_UNKNOWN", source } } },
      },
      unusedContext,
    ),
  ).toBeUndefined();
});

test("the actual read target supplies operation context when preflight only knows the workspace", async () => {
  const event = failure("LINEAR_WORKSPACE_CONNECTION_FAILED");
  event.details.failure.cause = new ResourceError(
    "LINEAR_WORKSPACE_CONNECTION_FAILED",
    "linear://example",
    "not-applied",
  );
  const result = await diagnosed(event);
  expect(result.text[0]).toContain("get_issue failed while checking the workspace");
  expect(result.text[0]).toContain("connection failed");
});
