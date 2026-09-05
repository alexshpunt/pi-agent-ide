import { Type } from "typebox";
import { expect, test } from "vitest";

import { ToolCallInterceptionRenderStore, withToolCallInterceptionRendering } from "./index.js";

import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

const BACKGROUNDS = {
  toolPendingBg: "\u001B[48;5;235m",
  toolSuccessBg: "\u001B[48;5;236m",
  toolErrorBg: "\u001B[48;5;52m",
} as const;

const theme = Object.assign(Object.create(null) as Theme, {
  bold: (text: string): string => text,
  fg: (_color: string, text: string): string => text,
  getBgAnsi: (color: keyof typeof BACKGROUNDS): string => BACKGROUNDS[color],
});

class ResettingComponent implements Component {
  public constructor(private readonly text: string) {}

  public render(): string[] {
    return [this.text];
  }

  public invalidate(): void {}
}

const definition: ToolDefinition = {
  name: "resetting",
  label: "resetting",
  description: "test",
  parameters: Type.Object({}),
  async execute(): Promise<AgentToolResult<unknown>> {
    return { content: [], details: undefined };
  },
  renderCall: () => new ResettingComponent("call\u001B[0mafter"),
  renderResult: () => new ResettingComponent("result\u001B[49mafter"),
};

test("preserves Pi's pending, success, and error backgrounds around intercepted renderers", () => {
  const wrapped = withToolCallInterceptionRendering(
    definition,
    new ToolCallInterceptionRenderStore(),
  );
  const pending = wrapped.renderCall?.({}, theme, context({ isPartial: true }));
  const success = wrapped.renderResult?.(
    { content: [], details: undefined },
    { expanded: false, isPartial: false },
    theme,
    context({ isPartial: false }),
  );
  const error = wrapped.renderResult?.(
    { content: [], details: undefined },
    { expanded: false, isPartial: false },
    theme,
    context({ isPartial: false, isError: true }),
  );

  expect(pending?.render(80)).toEqual([`call\u001B[0m${BACKGROUNDS.toolPendingBg}after`]);
  expect(success?.render(80)).toEqual([`result\u001B[49m${BACKGROUNDS.toolSuccessBg}after`]);
  expect(error?.render(80)).toEqual([`result\u001B[49m${BACKGROUNDS.toolErrorBg}after`]);
});

test("leaves self-rendered tool backgrounds under the renderer's control", () => {
  const wrapped = withToolCallInterceptionRendering(
    { ...definition, renderShell: "self" },
    new ToolCallInterceptionRenderStore(),
  );
  const rendered = wrapped.renderCall?.({}, theme, context({ isPartial: true })).render(80);

  expect(rendered).toEqual(["call\u001B[0mafter"]);
});

function context(state: {
  readonly isPartial: boolean;
  readonly isError?: boolean;
}): RenderContext {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: state.isPartial,
    expanded: false,
    showImages: false,
    isError: state.isError ?? false,
  };
}
