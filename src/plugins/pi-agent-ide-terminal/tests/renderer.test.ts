import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";

import {
  outputTail,
  renderActiveTerminal,
  renderRunResult,
  renderTerminalActionResult,
  renderTerminalWidgetLines,
  terminalCardLines,
} from "#src/plugins/pi-agent-ide-terminal/src/renderer.js";
import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.js";

const theme = { fg: (_color: never, text: string) => text } as never;

function snapshot(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    id: "abcdef123456",
    source: "shell:abcdef123456",
    command: "pnpm dev",
    cwd: "/workspace/project",
    shell: "Bash",
    shellFamily: "posix",
    background: true,
    status: "running",
    startedAt: 1_000,
    elapsedMs: 12_000,
    output: "booting\r\nready\r\nlatest\r\n",
    outputStart: 0,
    outputEnd: 24,
    truncated: false,
    cols: 100,
    rows: 30,
    ...overrides,
  };
}

describe("terminal renderer", () => {
  test("renders an action outcome without repeating terminal identity", () => {
    const lines = renderTerminalActionResult("write", ["new output"], theme).render(80);

    expect(lines.map((line) => line.trimEnd())).toEqual(["  new output", "✓ sent"]);
    expect(lines.join("\n")).not.toContain("bash ·");
    expect(lines.join("\n")).not.toContain("write text");
  });
  test("keeps identity and prompt ahead of the live output tail", () => {
    const lines = renderActiveTerminal(snapshot()).split("\n");

    expect(lines.slice(0, 2)).toEqual(["bash · /workspace/project · background", "$ pnpm dev"]);
    expect(lines.slice(2)).toEqual(["  ready", "  latest", "● running · 12s"]);
  });

  test("freezes completed status with elapsed time and exit code", () => {
    const lines = terminalCardLines(
      snapshot({ status: "completed", elapsedMs: 2_500, exitCode: 0 }),
      3,
      theme,
    );

    expect(lines.at(-1)).toBe("✓ completed · 2.5s · exit 0");
  });

  test("matches the compact read output row limit", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
    const lines = renderRunResult(snapshot({ output }), false, theme).render(100);

    expect(lines).toHaveLength(14);
    expect(lines[0]).toContain("8 earlier lines");
    expect(lines[1]).toContain("line-9");
    expect(lines[12]).toContain("line-20");
    expect(lines[13]).toContain("running");
  });

  test("expanded terminal result includes the complete retained output", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
    const lines = renderRunResult(snapshot({ output }), true, theme).render(100);

    expect(lines.some((line) => line.includes("line-1"))).toBe(true);
    expect(lines.some((line) => line.includes("line-30"))).toBe(true);
    expect(lines.some((line) => line.includes("earlier lines"))).toBe(false);
  });

  test("renders PowerShell with its native prompt marker", () => {
    const lines = terminalCardLines(
      snapshot({ shell: "PowerShell", shellFamily: "powershell" }),
      0,
      theme,
    );

    expect(lines[1]).toBe("PS> pnpm dev");
  });

  test("bounds every widget row and keeps the border intact", () => {
    const lines = renderTerminalWidgetLines(
      [snapshot({ command: "a very long command ".repeat(10) })],
      48,
      theme,
    );

    expect(lines[0]).toContain("Terminals");
    expect(lines.at(-1)).toContain("╰");
    expect(lines.every((line) => visibleWidth(stripTerminalSequences(line)) <= 48)).toBe(true);
  });

  test("returns only meaningful final output rows", () => {
    expect(outputTail("first\r\n\r\nsecond\r\nthird\r\n", 2)).toEqual(["second", "third"]);
  });
});
