import { fixtureHost, required } from "./fixtures/check.ts";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { connectLinearPermissionGate } from "#linear/operation-actions.ts";

test("identity replacement consumes existing approval and rejects a late answer from the previous identity", async () => {
  let registered: ((event: ToolCallEvent, context: ExtensionContext) => unknown) | undefined;
  const on = ((
    name: string,
    callback: (event: ToolCallEvent, context: ExtensionContext) => unknown,
  ) => {
    if (name === "tool_call") registered = callback;
    return () => {};
  }) as ExtensionAPI["on"];
  const pi = fixtureHost<ExtensionAPI>({
    on,
    events: createEventBus(),
  });
  const permit = connectLinearPermissionGate(pi, () => true);
  const hook = required(registered);
  const input = { path: "linear://example/diff/approved#merge", content: "{}" };
  const request: ToolCallEvent = {
    type: "tool_call",
    toolCallId: "auth-permit-test",
    toolName: "linear_write",
    input,
  };
  const context = fixtureHost<ExtensionContext>({
    hasUI: true,
    mode: "tui",
    ui: { confirm: async () => true },
  });
  await hook(request, context);
  permit.clear();
  expect(() => permit(input.path, input.content)).toThrow("LINEAR_CONFIRMATION_REQUIRED");
  let approve!: (value: boolean) => void;
  const pending = hook(
    request,
    fixtureHost<ExtensionContext>({
      ...context,
      ui: {
        confirm: () =>
          new Promise<boolean>((resolve) => {
            approve = resolve;
          }),
      },
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  permit.clear();
  approve(true);
  expect(await pending).toMatchObject({ block: true });
  expect(() => permit(input.path, input.content)).toThrow("LINEAR_CONFIRMATION_REQUIRED");
});
