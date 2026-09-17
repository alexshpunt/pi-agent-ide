import path from "node:path";

import { createTextDocument } from "pi-agent-text";
import { expect, test } from "vitest";

import { createBreakpointPresenter } from "#src/plugins/pi-agent-ide-debugger/src/breakpoint-view.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

test.skipIf(process.platform === "win32")(
  "breakpoint view aggregates normal file reads and scopes debug source reads",
  async () => {
    const manager = new DebugSessionManager();
    const file = path.resolve("example.py");
    const first = manager.create({
      adapter: "debugpy",
      program: file,
      args: [],
      cwd: process.cwd(),
    });
    const second = manager.create({
      adapter: "debugpy",
      program: file,
      args: [],
      cwd: process.cwd(),
    });
    const firstBreakpoint = await manager.addBreakpoint(manager.sourceResource(first), 2);
    await manager.addBreakpoint(manager.sourceResource(second), 2);
    const presenter = createBreakpointPresenter(manager);
    const document = createTextDocument(file, "first\nsecond\nthird\n");

    const combined = await presenter.present(document, {
      purpose: "read",
      source: file,
      cwd: process.cwd(),
      resolvedBy: "filesystem",
      requestedViews: ["breakpoints"],
    });
    expect(combined.lines[1]?.presentation?.suffix).toContain(firstBreakpoint.source);
    expect(combined.lines[1]?.presentation?.compactSuffix).toContain("2 breakpoints");

    const scoped = await presenter.present(document, {
      purpose: "read",
      source: manager.sourceResource(first),
      cwd: process.cwd(),
      resolvedBy: "debugger",
      requestedViews: ["breakpoints"],
    });
    expect(scoped.lines[1]?.presentation?.suffix).toContain(firstBreakpoint.source);
    expect(scoped.lines[1]?.presentation?.compactSuffix).toContain("○ breakpoint");
    expect(scoped.lines[1]?.presentation?.compactSuffix).not.toContain("2 breakpoints");
  },
);
