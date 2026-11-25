import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { required } from "./fixtures/check.ts";
import { expect, test } from "vitest";
import { connectLinearApiReceipts } from "#linear/api-receipts.ts";

const source = "linear://example/api/results/20000000-0000-4000-8000-000000000002";
function fixture() {
  let registered: ((event: ToolResultEvent) => unknown) | undefined;
  connectLinearApiReceipts({
    on: (name: string, handler: (event: ToolResultEvent) => unknown) => {
      expect(name).toBe("tool_result");
      registered = handler;
      return () => {};
    },
  } as ExtensionAPI);
  const hook = required(registered);
  return (event: Pick<ToolResultEvent, "toolName" | "content" | "details">) =>
    hook({
      ...event,
      type: "tool_result",
      toolCallId: "api-receipt-test",
      input: {},
      isError: false,
    });
}
test("unknown raw outcomes retain the ordinary error flag and public renderer effect", () => {
  const action = {
    kind: "linear-graphql",
    source,
    request: "linear://example/api/graphql",
    workspace: "example",
    ok: false,
    effect: "unknown",
  };
  const details = { results: [], metadata: { semanticAction: action } };
  const result = fixture()({ toolName: "write", content: [], details });
  expect(result).toMatchObject({
    isError: true,
    details: { effect: "unknown", metadata: { semanticAction: action } },
  });
});
test("a successful read-only raw query is not reclassified as a failed mutation", () => {
  expect(
    fixture()({
      toolName: "write",
      content: [],
      details: {
        metadata: {
          semanticAction: {
            kind: "linear-graphql",
            source,
            request: "linear://example/api/graphql",
            workspace: "example",
            ok: true,
            effect: "not-applied",
          },
        },
      },
    }),
  ).toBeUndefined();
});
