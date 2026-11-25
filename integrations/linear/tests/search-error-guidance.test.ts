import { required } from "./fixtures/check.ts";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { connectLinearSearchErrorGuidance } from "#linear/search-error-guidance.ts";

function hook() {
  let registered: ((event: ToolResultEvent) => unknown) | undefined;
  connectLinearSearchErrorGuidance({
    on: (name: string, handler: (event: ToolResultEvent) => unknown) => {
      expect(name).toBe("tool_result");
      registered = handler;
      return () => {};
    },
  } as ExtensionAPI);
  return required(registered);
}
const failed = (message: string, toolName = "search"): ToolResultEvent => ({
  type: "tool_result",
  toolCallId: "linear-search-test",
  input: {},
  details: undefined,
  toolName,
  isError: true,
  content: [{ type: "text", text: message }],
});

test.each(["search", "linear_search"])(
  "an invalid object-search scope on %s points to the filtered GraphQL list",
  (toolName) => {
    const event = failed("Resolver linear failed: LINEAR_INVALID_SEARCH_SCOPE", toolName);
    const result = hook()(event);
    expect(result).toMatchObject({ content: [{ type: "text" }, event.content[0]] });
    expect(JSON.stringify(result)).toContain("docs:linear-discovery");
    expect(event.content).toHaveLength(1);
  },
);

test("other failures, successes, other tools and look-alike codes keep their output", () => {
  const apply = hook();
  expect(apply(failed("Resolver linear failed: LINEAR_EMPTY_QUERY"))).toBeUndefined();
  expect(apply(failed("LINEAR_INVALID_SEARCH_SCOPE_EXTRA"))).toBeUndefined();
  expect(apply(failed("LINEAR_INVALID_SEARCH_SCOPE", "read"))).toBeUndefined();
  expect(apply({ ...failed("LINEAR_INVALID_SEARCH_SCOPE"), isError: false })).toBeUndefined();
});
