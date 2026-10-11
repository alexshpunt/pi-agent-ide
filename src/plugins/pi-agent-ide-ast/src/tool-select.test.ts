import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ReadPluginApi } from "pi-agent-read/api/plugin-protocol";
import { expect, test, vi } from "vitest";
import { registerSelect } from "./tool-select.js";

test("Select renders a guarded Read failure without treating structured error metadata as a result panel", async () => {
  const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
  const pi = Object.assign(Object.create(null) as ExtensionAPI, {
    registerTool,
    on: vi.fn(),
    events: { emit: vi.fn(), on: () => () => {} },
  });
  const read = Object.assign(Object.create(null) as ReadPluginApi, {
    async read() {
      return { isError: true, content: [{ type: "text", text: "Owned read denied" }] };
    },
  });
  await registerSelect(pi, read);
  const definition = registerTool.mock.calls[0]?.[0];
  if (!definition) throw Error("Select was not registered");
  const context = Object.assign(Object.create(null) as Parameters<typeof definition.execute>[4], {
    cwd: process.cwd(),
  });
  const result = await definition.execute(
    "guarded",
    { path: "ssh://owned/work/secret.ts", operation: { kind: "position", edge: "after" } },
    undefined,
    undefined,
    context,
  );
  const renderContext = Object.assign(
    Object.create(null) as Parameters<NonNullable<ToolDefinition["renderResult"]>>[3],
    {
      isError: true,
      isPartial: false,
      expanded: true,
      cwd: process.cwd(),
      state: {},
      args: {},
      toolCallId: "guarded",
      executionStarted: true,
      argsComplete: true,
    },
  );
  const component = definition.renderResult?.(
    { ...result, details: { documentation: { kind: "attachment", ids: ["select-code"] } } },
    { expanded: true, isPartial: false },
    theme,
    renderContext,
  );
  expect(component?.render(80).join("\n")).toContain("Select could not read this source");
});
const backgrounds = {
  toolPendingBg: "\u001B[48;5;235m",
  toolSuccessBg: "\u001B[48;5;236m",
  toolErrorBg: "\u001B[48;5;52m",
} as const;
const theme = Object.assign(Object.create(null) as Theme, {
  bold: (text: string) => text + "\u001B[0m",
  underline: (text: string) => text + "\u001B[m",
  fg: (_color: string, text: string) => text + "\u001B[39m",
  bg: (_color: string, text: string) => "\u001B[48;5;25m" + text + "\u001B[49m",
  getBgAnsi: (color: keyof typeof backgrounds) => backgrounds[color],
});

test("registered Select restores the tool background after selected code and wrapped rows", async () => {
  const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
  const pi = Object.assign(Object.create(null) as ExtensionAPI, {
    registerTool,
    on: vi.fn(),
    events: { emit: vi.fn(), on: () => () => {} },
  });
  await registerSelect(pi, Object.create(null) as ReadPluginApi);
  const definition = registerTool.mock.calls[0]?.[0];
  expect(definition?.name).toBe("select");
  if (!definition) throw Error("Select was not registered");
  for (const state of [
    { isPartial: true, isError: false, background: backgrounds.toolPendingBg },
    { isPartial: false, isError: false, background: backgrounds.toolSuccessBg },
    { isPartial: false, isError: true, background: backgrounds.toolErrorBg },
  ]) {
    const context: Parameters<NonNullable<ToolDefinition["renderResult"]>>[3] = {
      args: {},
      toolCallId: "select-background",
      durationMs: undefined,
      outputPad: 0,
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      expanded: true,
      showImages: false,
      ...state,
    };
    const component = definition.renderResult?.(
      {
        content: [],
        details: {
          summary: "1 selection in 1 file",
          rows: [
            { kind: "source", label: "example.txt" },
            {
              kind: "line",
              lineNumber: 1,
              text: "before needle after tail",
              ranges: [{ from: 7, to: 13 }],
            },
            { kind: "note", text: "1 origin", expandedOnly: true },
          ],
        },
      },
      { expanded: true, isPartial: state.isPartial },
      theme,
      context,
    );
    const output = component?.render(22).join("\n") ?? "";
    expect(output).toContain("\u001B[49m" + state.background);
    expect(output).not.toMatch(/\u001B\[(?:0|49)?m(?!\u001B\[48;5;)/u);
  }
});
