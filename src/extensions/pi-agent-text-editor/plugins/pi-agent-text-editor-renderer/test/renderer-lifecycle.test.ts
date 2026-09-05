import { FileMutationResult } from "pi-agent-text-editor/api/mutation-result";

import { TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH } from "pi-agent-tool-call-interception";
import { afterEach, describe, expect, test, vi } from "vitest";

// The lifecycle check supplies deterministic highlighting so it only observes renderer state.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getLanguageFromPath: () => undefined,
  highlightCode: vi.fn((source: string) => source.split("\n")),
}));

import * as frozenViewport from "#src/frozen-viewport.js";
import { registerMutationRenderers } from "#src/renderer.js";

import { compactMutationDetails } from "#src/persisted-result.js";

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TextMutationPreviewResource } from "pi-agent-text-editor/api/mutation-preview";
import type { TextEditorPluginApi } from "pi-agent-text-editor/api/plugin-protocol";
import type { TextEditorToolRendererRegistration } from "pi-agent-text-editor/api/tool-renderer";

const background = vi.fn((_color: ThemeColor, text: string) => text);

const theme: Theme = Object.assign(Object.create(null) as Theme, {
  fg: (_color: ThemeColor, text: string) => text,
  bg: background,
  bold: (text: string) => text,
  underline: (text: string) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor" as const,
});

afterEach(() => {
  vi.restoreAllMocks();
  background.mockClear();
  vi.useRealTimers();
});

describe("mutation renderer lifecycle", () => {
  test("restores a completed row without asking the engine to read today's source", async () => {
    let renderer: TextEditorToolRendererRegistration | undefined;
    const previewMutation = vi.fn();
    const api = Object.assign(Object.create(null) as TextEditorPluginApi, {
      onMutationTool(listener: (registration: unknown) => void) {
        listener({ name: "replace", source: { field: "path" } });
      },
      addToolRenderer(value: TextEditorToolRendererRegistration) {
        renderer = value;
      },
      previewMutation,
    });
    registerMutationRenderers(api);
    if (renderer?.renderCall === undefined || renderer.renderResult === undefined)
      throw new Error("Missing renderer");
    const args = { path: "removed.txt", start: "old", text: "new" };
    const context = {
      args,
      toolCallId: "restored",
      state: {},
      lastComponent: undefined,
      cwd: process.cwd(),
      executionStarted: false,
      argsComplete: false,
      isPartial: true,
      expanded: false,
      showImages: true,
      isError: false,
      invalidate: vi.fn(),
    };
    const panel = renderer.renderCall(args, theme, context);
    const details = compactMutationDetails({
      results: [
        new FileMutationResult({
          ok: true,
          path: "removed.txt",
          beforeContentMap: { "removed.txt": "old\n" },
          afterContent: "new\n",
        }),
      ],
    });
    renderer.renderResult(
      { content: [{ type: "text", text: "changed" }], details },
      { expanded: false, isPartial: false },
      theme,
      { ...context, isPartial: false },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(previewMutation).not.toHaveBeenCalled();
    expect(panel.render(80).join("\n")).toContain("new");
  });
  test("TS-04 keeps one typing timer, then finalizes quiescently", async () => {
    vi.useFakeTimers();
    const interval = vi.spyOn(globalThis, "setInterval");
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const finalModel = vi.spyOn(frozenViewport, "projectFinalResources");
    const generated = "first line\nsecond line\n";
    const resource: TextMutationPreviewResource = {
      path: "lifecycle.txt",
      beforeRanges: [{ from: 0, to: 0 }],
      ranges: [{ from: 0, to: generated.length }],
      beforeContent: "",
      afterContent: generated,
    };
    let renderer: TextEditorToolRendererRegistration | undefined;
    const api = Object.assign(Object.create(null) as TextEditorPluginApi, {
      onMutationTool(listener: (registration: unknown) => void): void {
        listener({ name: "write", source: { field: "path" } });
      },
      addToolRenderer(value: TextEditorToolRendererRegistration): void {
        renderer = value;
      },
      previewMutation: vi.fn(async () => ({ kind: "completed" as const, resources: [resource] })),
    });
    registerMutationRenderers(api);
    if (renderer?.renderCall === undefined || renderer.renderResult === undefined) {
      throw new Error("Expected write renderer registration");
    }
    expect(renderer.renderShell).toBe("self");

    const state: Record<string, unknown> = {};
    let invalidations = 0;
    const callContext = {
      args: { path: "lifecycle.txt", content: generated },
      toolCallId: "lifecycle-write",
      invalidate: () => {
        invalidations++;
      },
      lastComponent: undefined,
      state,
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: false,
      isPartial: true,
      expanded: false,
      showImages: true,
      isError: false,
    };
    const panel = renderer.renderCall(callContext.args, theme, callContext);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(api.previewMutation).toHaveBeenCalledTimes(1);
    expect(interval).toHaveBeenCalledTimes(1);
    expect(state.timer).toBeDefined();
    expect(panel.render(120).join("\n")).toContain("▌");

    expect(background).toHaveBeenLastCalledWith("toolPendingBg", expect.any(String));
    expect(state.timer).toBeDefined();

    await vi.advanceTimersByTimeAsync(2_000);
    const idlePanel = panel.render(120);
    const idleInvalidations = invalidations;
    await vi.advanceTimersByTimeAsync(200);
    expect(panel.render(120)).toEqual(idlePanel);
    expect(invalidations).toBe(idleInvalidations);
    expect(idlePanel.join("\n")).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);

    renderer.renderResult(
      {
        content: [{ type: "text", text: "written" }],
        details: {
          results: [
            new FileMutationResult({
              ok: true,
              path: "lifecycle.txt",
              files: [{ path: "lifecycle.txt", action: "overwritten" }],
              beforeContentMap: { "lifecycle.txt": "" },
              afterContent: generated,
            }),
          ],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { ...callContext, isPartial: false, isError: false },
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(state.timer).toBeUndefined();
    expect(state.typing).toBeUndefined();
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(finalModel).toHaveBeenCalledTimes(1);
    const finalPanel = panel.render(120).join("\n");

    expect(background).toHaveBeenLastCalledWith("toolSuccessBg", expect.any(String));
    expect(finalPanel).not.toContain("▌");
    expect(finalPanel).toContain("first line");
    expect(finalPanel).toContain("second line");
    expect(finalPanel).toContain("+2 ~0 -0");
    const completedInvalidations = invalidations;
    await vi.advanceTimersByTimeAsync(200);
    expect(invalidations).toBe(completedInvalidations);
  });

  test.each(["", "last line\n"])("TS-04 finalizes %j content once", (generated) => {
    vi.useFakeTimers();
    const finalModel = vi.spyOn(frozenViewport, "projectFinalResources");
    let renderer: TextEditorToolRendererRegistration | undefined;
    const api = Object.assign(Object.create(null) as TextEditorPluginApi, {
      onMutationTool(listener: (registration: unknown) => void): void {
        listener({ name: "write", source: { field: "path" } });
      },
      addToolRenderer(value: TextEditorToolRendererRegistration): void {
        renderer = value;
      },
    });
    registerMutationRenderers(api);
    if (renderer?.renderCall === undefined || renderer.renderResult === undefined) {
      throw new Error("Expected write renderer registration");
    }

    const state: Record<string, unknown> = {};
    const context = {
      args: { path: "variant.txt", content: generated },
      toolCallId: "variant-write",
      invalidate: vi.fn(),
      lastComponent: undefined,
      state,
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: false,
      isPartial: false,
      expanded: false,
      showImages: true,
      isError: false,
    };
    const panel = renderer.renderCall(context.args, theme, context);
    renderer.renderResult(
      {
        content: [{ type: "text", text: "written" }],
        details: {
          results: [
            new FileMutationResult({
              ok: true,
              path: "variant.txt",
              files: [{ path: "variant.txt", action: "overwritten" }],
              beforeContentMap: { "variant.txt": "" },
              afterContent: generated,
            }),
          ],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      context,
    );

    expect(finalModel).toHaveBeenCalledTimes(1);
    const rendered = panel.render(120).join("\n");
    expect(rendered).not.toContain("▌");
    if (generated.length > 0) {
      expect(rendered).toContain("last line");
      expect(rendered).toContain("+1 ~0 -0");
    } else {
      expect(rendered).not.toContain("+1 ~0 -0");
    }
  });

  test("keeps a pending delete still without a timer until the final removal diff", async () => {
    vi.useFakeTimers();
    let renderer: TextEditorToolRendererRegistration | undefined;
    const api = Object.assign(Object.create(null) as TextEditorPluginApi, {
      onMutationTool(listener: (registration: unknown) => void): void {
        listener({ name: "delete", source: { field: "path" } });
      },
      addToolRenderer(value: TextEditorToolRendererRegistration): void {
        renderer = value;
      },
    });
    registerMutationRenderers(api);
    if (renderer?.renderCall === undefined || renderer.renderResult === undefined) {
      throw new Error("Expected delete renderer registration");
    }

    const state: Record<string, unknown> = {};
    const context = {
      args: { path: "legacy.ts", start: "legacy();" },
      toolCallId: "delete-legacy",
      invalidate: vi.fn(),
      lastComponent: undefined,
      state,
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: true,
      isError: false,
    };
    const panel = renderer.renderCall(context.args, theme, context);
    const firstTail = panel.render(100).at(-1);

    await vi.advanceTimersByTimeAsync(80);

    const secondTail = panel.render(100).at(-1);
    expect(secondTail).toBe(firstTail);
    expect(panel.render(100).join("\n")).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
    expect(context.invalidate).not.toHaveBeenCalled();
    expect(state.timer).toBeUndefined();

    renderer.renderResult(
      {
        content: [{ type: "text", text: "deleted" }],
        details: {
          results: [
            new FileMutationResult({
              ok: true,
              path: "legacy.ts",
              files: [{ path: "legacy.ts", action: "edited" }],
              beforeContentMap: { "legacy.ts": "keep();\nlegacy();\n" },
              afterContent: "keep();\n",
            }),
          ],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { ...context, isPartial: false },
    );

    const finalPanel = panel.render(100).join("\n");
    expect(state.timer).toBeUndefined();
    expect(finalPanel).toContain("-1");
    expect(finalPanel).not.toContain("⠋");
  });

  test("labels resolved diff resources only when the tool call has no source path", () => {
    let renderer: TextEditorToolRendererRegistration | undefined;
    const api = Object.assign(Object.create(null) as TextEditorPluginApi, {
      onMutationTool(listener: (registration: unknown) => void): void {
        listener({ name: "delete", source: { field: "path" } });
      },
      addToolRenderer(value: TextEditorToolRendererRegistration): void {
        renderer = value;
      },
    });
    registerMutationRenderers(api);
    const renderCall = renderer?.renderCall;
    const renderResult = renderer?.renderResult;
    if (renderCall === undefined || renderResult === undefined) {
      throw new Error("Expected delete renderer registration");
    }

    const render = (
      args: Readonly<Record<string, unknown>>,
      files: readonly { readonly path: string; readonly before: string; readonly after: string }[],
    ): string => {
      const state: Record<string, unknown> = {};
      const context = {
        args,
        toolCallId: "delete-resolved-resources",
        invalidate: vi.fn(),
        lastComponent: undefined,
        state,
        cwd: process.cwd(),
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: true,
        isError: false,
      };
      const panel = renderCall(args, theme, context);
      renderResult(
        {
          content: [{ type: "text", text: "deleted" }],
          details: {
            results: files.map(
              (file) =>
                new FileMutationResult({
                  ok: true,
                  path: file.path,
                  files: [{ path: file.path, action: "edited" }],
                  beforeContentMap: { [file.path]: file.before },
                  afterContent: file.after,
                }),
            ),
          },
        },
        { expanded: false, isPartial: false },
        theme,
        context,
      );
      return panel.render(100).join("\n");
    };

    const derived = render({ start: "SEARCH#EXAMPLE:all:match" }, [
      { path: "agents/reviewer.md", before: "deny: delegate", after: "deny: review" },
      { path: "agents/developer.md", before: "deny: delegate", after: "deny: build" },
    ]);
    expect(derived).toMatch(/╭─ agents\/reviewer\.md /u);
    expect(derived).toMatch(/╭─ agents\/developer\.md /u);

    const explicit = render({ path: "agents/reviewer.md", start: "deny: delegate" }, [
      { path: "agents/reviewer.md", before: "deny: delegate", after: "deny: review" },
    ]);
    expect(explicit.match(/agents\/reviewer\.md/gu)).toHaveLength(1);
    expect(explicit).not.toMatch(/╭─ agents\/reviewer\.md /u);
  });

  test("TS-04 disposes an active typing timer when arguments become incomplete", async () => {
    vi.useFakeTimers();
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const generated = "dispose me";
    const resource: TextMutationPreviewResource = {
      path: "dispose.txt",
      beforeRanges: [{ from: 0, to: 0 }],
      ranges: [{ from: 0, to: generated.length }],
      beforeContent: "",
      afterContent: generated,
    };
    let renderer: TextEditorToolRendererRegistration | undefined;
    const api = Object.assign(Object.create(null) as TextEditorPluginApi, {
      onMutationTool(listener: (registration: unknown) => void): void {
        listener({ name: "write", source: { field: "path" } });
      },
      addToolRenderer(value: TextEditorToolRendererRegistration): void {
        renderer = value;
      },
      previewMutation: vi.fn(async () => ({ kind: "completed" as const, resources: [resource] })),
    });
    registerMutationRenderers(api);
    if (renderer?.renderCall === undefined) {
      throw new Error("Expected write renderer registration");
    }
    const state: Record<string, unknown> = {};
    const context = {
      args: { path: "dispose.txt", content: generated },
      toolCallId: "dispose-write",
      invalidate: vi.fn(),
      lastComponent: undefined,
      state,
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: false,
      isPartial: true,
      expanded: false,
      showImages: true,
      isError: false,
    };
    renderer.renderCall(context.args, theme, context);
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    expect(state.timer).toBeDefined();

    renderer.renderCall(context.args, theme, { ...context, argsComplete: false, isPartial: false });
    expect(state.timer).toBeUndefined();
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  test("keeps long generated arguments bounded in an expanded header", () => {
    let renderer: TextEditorToolRendererRegistration | undefined;
    const api = Object.assign(Object.create(null) as TextEditorPluginApi, {
      onMutationTool(listener: (registration: unknown) => void): void {
        listener({ name: "write", source: { field: "path" } });
      },
      addToolRenderer(value: TextEditorToolRendererRegistration): void {
        renderer = value;
      },
    });
    registerMutationRenderers(api);
    if (renderer?.renderCall === undefined) {
      throw new Error("Expected write renderer registration");
    }

    const content = "generated ".repeat(80);
    const args = { path: "large.txt", content };
    const panel = renderer.renderCall(args, theme, {
      args,
      toolCallId: "expanded-large-write",
      invalidate: vi.fn(),
      lastComponent: undefined,
      state: {},
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: false,
      isPartial: false,
      expanded: true,
      showImages: true,
      isError: false,
    });
    const rendered = panel.render(100).join("\n");
    const inline = rendered.replaceAll(/\s+/g, " ");

    expect(inline).toContain("path=large.txt");
    expect(inline).toContain("content=generated");
    expect(inline).toContain(`${String(content.length)} chars; full value shown in diff`);
    expect(rendered).not.toContain(content);
  });

  test("keeps the header stable when anchor details resolve during active rendering", () => {
    let renderer: TextEditorToolRendererRegistration | undefined;
    const api = Object.assign(Object.create(null) as TextEditorPluginApi, {
      onMutationTool(listener: (registration: unknown) => void): void {
        listener({
          name: "delete",
          source: { field: "path" },
          pair: ["start", "end"],
          anchors: [
            { field: "start", sourceField: "path", kinds: ["search"] },
            { field: "end", sourceField: "path", kinds: ["search"] },
          ],
        });
      },
      addToolRenderer(value: TextEditorToolRendererRegistration): void {
        renderer = value;
      },
    });
    registerMutationRenderers(api);
    if (renderer?.renderCall === undefined) {
      throw new Error("Expected delete renderer registration");
    }

    const args = { path: "service.ts", start: "SEARCH#EXAMPLE:all:match" };
    const state: Record<PropertyKey, unknown> = {};
    const context = {
      args,
      toolCallId: "stable-active-header",
      invalidate: vi.fn(),
      lastComponent: undefined,
      state,
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: true,
      isError: false,
    };
    const panel = renderer.renderCall(args, theme, context);
    const firstHeader = panel.render(100)[0];

    state[TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH] = {
      start: {
        kind: "resolved",
        full: "SEARCH#EXAMPLE:all:match",
        compact: "all matches",
        resolverId: "search",
      },
    };
    renderer.renderCall(args, theme, { ...context, lastComponent: panel });

    expect(panel.render(100)[0]).toBe(firstHeader);
    expect(firstHeader).toContain("selected range");
    expect(firstHeader).not.toContain("all matches");
    renderer.renderCall(args, theme, {
      ...context,
      lastComponent: panel,
      argsComplete: false,
      isPartial: false,
    });
  });

  test("shows semantic anchors when compact and exact anchors when expanded", () => {
    let renderer: TextEditorToolRendererRegistration | undefined;
    const api = Object.assign(Object.create(null) as TextEditorPluginApi, {
      onMutationTool(listener: (registration: unknown) => void): void {
        listener({
          name: "delete",
          source: { field: "path" },
          pair: ["start", "end"],
          anchors: [
            { field: "start", sourceField: "path", kinds: ["search"] },
            { field: "end", sourceField: "path", kinds: ["search"] },
          ],
        });
      },
      addToolRenderer(value: TextEditorToolRendererRegistration): void {
        renderer = value;
      },
    });
    registerMutationRenderers(api);
    if (renderer?.renderCall === undefined) {
      throw new Error("Expected delete renderer registration");
    }

    const anchor = "SEARCH#EXAMPLE:all:match";
    const args = { path: "src/example.ts", start: anchor };
    const state: Record<PropertyKey, unknown> = {
      [TOOL_CALL_INTERCEPTION_ANCHOR_RENDER_PATCH]: {
        start: {
          kind: "resolved",
          full: anchor,
          compact: "all matches",
          resolverId: "search",
        },
      },
    };
    const context = {
      args,
      toolCallId: "delete-search-selection",
      invalidate: vi.fn(),
      lastComponent: undefined,
      state,
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: true,
      isError: false,
    };
    const compact = renderer.renderCall(args, theme, context);
    const compactText = compact.render(100).join("\n");

    expect(compactText).toContain("all matches");
    expect(compactText).not.toContain("SEARCH#");

    const expanded = renderer.renderCall(args, theme, {
      ...context,
      lastComponent: compact,
      expanded: true,
    });
    const expandedText = expanded.render(100).join("\n");

    expect(expandedText).toContain(anchor);

    expect(expandedText).toContain("path=src/example.ts");
    expect(expandedText).toContain(`start=${anchor}`);
  });
});
