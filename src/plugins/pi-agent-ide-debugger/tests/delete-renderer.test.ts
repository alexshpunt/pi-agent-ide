import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  TEXT_EDITOR_PLUGIN_REGISTER_EVENT,
  isTextEditorPluginRegistrationRequest,
  type TextEditorPluginApi,
} from "pi-agent-text-editor/api/plugin-protocol";
import type { TextEditorToolRendererRegistration } from "pi-agent-text-editor/api/tool-renderer";
import { expect, test } from "vitest";

import registerDebugger from "#src/plugins/pi-agent-ide-debugger/index.js";
import { retainReloadResource } from "#src/core/reload-resource-store.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

type SemanticHandler = Parameters<ReturnType<TextEditorPluginApi["tool"]>["addSemanticHandler"]>[0];

test("breakpoint removal keeps its call label after deletion and later session cleanup", async () => {
  const manager = new DebugSessionManager();
  const session = manager.create({
    adapter: "debugpy",
    program: "/workspace/example.py",
    cwd: "/workspace",
    args: [],
  });
  const breakpoint = await manager.addBreakpoint(`${session.source}/source`, 1);
  retainReloadResource("debugger", manager);
  const events = createEventBus();
  const pi: Partial<ExtensionAPI> = { events, on: () => () => {}, registerTool: () => {} };
  let renderer: TextEditorToolRendererRegistration | undefined;
  let handler: SemanticHandler | undefined;
  events.on(TEXT_EDITOR_PLUGIN_REGISTER_EVENT, (request) => {
    if (!isTextEditorPluginRegistrationRequest(request)) throw new Error("Invalid plugin request");
    const api: Partial<TextEditorPluginApi> = {
      addResolver: () => {},
      describe: () => {},
      tool: (name) => ({
        describe: () => {},
        addHandler: () => {},
        addSemanticHandler: (registration) => {
          if (name === "delete") handler = registration;
        },
      }),
      addToolRenderer: (registration) => {
        if (registration.tool === "delete") renderer = registration;
      },
    };
    request.accept(Promise.resolve(request.plugin.setup(api as TextEditorPluginApi)));
  });
  await registerDebugger(pi as ExtensionAPI);
  const renderCall = renderer?.renderCall;
  if (renderCall === undefined || handler === undefined)
    throw new Error("Missing Delete renderer or handler");
  const deleteHandler = handler;
  const theme = { fg: (_color: unknown, text: string) => text } as Parameters<typeof renderCall>[1];
  const context = { state: {} } as Parameters<typeof renderCall>[2];
  const render = (source: string, renderContext = context) =>
    renderCall({ path: source }, theme, renderContext).render(100).join("\n");
  const remove = (source: string) =>
    deleteHandler.execute({} as Parameters<SemanticHandler["execute"]>[0], { path: source });
  try {
    const before = render(breakpoint.source);
    expect(before).toContain("remove breakpoint · example.py:1");
    await remove(breakpoint.source);
    expect(manager.breakpoint(breakpoint.source)).toBeUndefined();
    expect(manager.get(session.source)).toBe(session);
    expect(render(breakpoint.source)).toBe(before);
    expect(render(breakpoint.source, { state: {} } as typeof context)).toBe(before);
    expect(render(session.source, { state: {} } as typeof context)).toContain("stop debugging");
    await remove(session.source);
    expect(manager.get(session.source)).toBeUndefined();
    expect(render(session.source, { state: {} } as typeof context)).toContain("stop debugging");
    expect(render(breakpoint.source)).toBe(before);
  } finally {
    await manager.dispose();
  }
});
