import { expect, test } from "vitest";

import {
  renderDebugActionCall,
  renderDebugResult,
} from "#src/plugins/pi-agent-ide-debugger/src/renderer.js";
import type { DebugSessionSnapshot } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

const theme = { fg: (_color: never, text: string) => text } as never;

function snapshot(overrides: Partial<DebugSessionSnapshot> = {}): DebugSessionSnapshot {
  return {
    id: "abcdef123456",
    source: "debug:abcdef123456",
    options: {
      adapter: "debugpy",
      program: "/workspace/pricing.py",
      sourceFile: "/workspace/pricing.py",
      cwd: "/workspace",
      args: [],
    },
    status: "stopped",
    breakpoints: [
      {
        id: "1234567890",
        source: "debug:abcdef123456/breakpoint/1234567890",
        file: "/workspace/pricing.py",
        line: 42,
        verified: true,
      },
    ],
    stop: {
      generation: 1,
      reason: "breakpoint",
      threadId: 1,
      frame: {
        id: 7,
        name: "calculate_total",
        line: 42,
        source: { path: "/workspace/pricing.py" },
      },
      sourceLines: [
        { lineNumber: 41, content: "discount = 7", current: false },
        { lineNumber: 42, content: "result = subtotal - discount", current: true },
        { lineNumber: 43, content: "return result", current: false },
      ],
      variables: [
        { name: "subtotal", value: "50", type: "int", variablesReference: 0 },
        { name: "discount", value: "7", type: "int", variablesReference: 0 },
      ],
    },
    ...overrides,
  };
}

test("debug action renderer hides insert and shows the semantic command", () => {
  const lines = renderDebugActionCall(snapshot(), "continue", theme).render(80).join("\n");
  expect(lines).toContain("debugpy · pricing.py");
  expect(lines).toContain("▶ continue");
  expect(lines).not.toContain("insert");
});

test("stopped result shows frame, source context, and locals", () => {
  const lines = renderDebugResult(snapshot(), false, theme).render(100).join("\n");
  expect(lines).toContain("stopped · breakpoint");
  expect(lines).toContain("calculate_total · pricing.py:42");
  expect(lines).toContain(">   42 result = subtotal - discount");
  expect(lines).toContain("subtotal");
  expect(lines).toContain("50");
});
