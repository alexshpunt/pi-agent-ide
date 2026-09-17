import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import { formatAgentTerminalSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/output-limits.js";

import {
  outputTail,
  renderActiveTerminal,
  renderRunResult,
  renderTerminalActionResult,
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
    lastActivityAt: 1_000,
    idleMs: 12_000,
    startedAt: 1_000,
    elapsedMs: 12_000,
    output: "booting\r\nready\r\nlatest\r\n",
    outputStart: 0,
    outputEnd: 24,
    truncated: false,
    fullOutputPath: "/tmp/pi-agent-ide-terminal/session.log",
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
    const lines = renderRunResult(snapshot({ output }), "compact", theme).render(100);

    expect(lines).toHaveLength(14);
    expect(lines[0]).toContain("8 earlier lines");
    expect(lines[1]).toContain("line-9");
    expect(lines[12]).toContain("line-20");
    expect(lines[13]).toContain("running");
  });

  test("full terminal result shows all available output", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
    const lines = renderRunResult(snapshot({ output }), "full", theme).render(100);

    expect(lines.some((line) => line.trim() === "line-1")).toBe(true);
    expect(lines.some((line) => line.includes("line-30"))).toBe(true);
    expect(lines.some((line) => line.includes("earlier lines"))).toBe(false);
    expect(lines).toHaveLength(31);
  });

  test("disabled terminal result keeps only status", () => {
    const lines = renderRunResult(
      snapshot({ output: "secret output", status: "completed", exitCode: 0 }),
      "disabled",
      theme,
    ).render(100);

    expect(lines.map((line) => line.trimEnd())).toEqual(["✓ completed · 12s · exit 0"]);
  });

  test("disabled terminal result preserves bounded failure output", () => {
    const output = Array.from({ length: 20 }, (_, index) => `failure-${index + 1}`).join("\n");
    const lines = renderRunResult(
      snapshot({ output, status: "completed", exitCode: 1, error: "command failed" }),
      "disabled",
      theme,
    ).render(100);

    expect(lines[0]).toContain("8 earlier lines");
    expect(lines.join("\n")).toContain("failure-20");
    expect(lines.join("\n")).toContain("command failed");
    expect(lines.at(-1)).toContain("exit 1");
  });

  test("bounds one extremely long output line", () => {
    const lines = renderRunResult(
      snapshot({ output: "x".repeat(100_000) + "THE-END" }),
      "full",
      theme,
    ).render(100);

    expect(lines.length).toBeLessThan(12);
    expect(lines.join("\n")).toContain("[truncated]");
  });

  test("formats large agent output as a recoverable tail", () => {
    const text = formatAgentTerminalSnapshot(
      snapshot({
        output: Array.from({ length: 2_100 }, (_, index) => `line-${index + 1}`).join("\n"),
      }),
    );

    expect(text).not.toContain("line-1\n");
    expect(text).toContain("line-2100");
    expect(text).toContain("Earlier output omitted");
    expect(text).toContain("fullOutput: /tmp/pi-agent-ide-terminal/session.log");
    expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });

  test("renders PowerShell with its native prompt marker", () => {
    const lines = terminalCardLines(
      snapshot({ shell: "PowerShell", shellFamily: "powershell" }),
      0,
      theme,
    );

    expect(lines[1]).toBe("PS> pnpm dev");
  });

  test("returns only meaningful final output rows", () => {
    expect(outputTail("first\r\n\r\nsecond\r\nthird\r\n", 2)).toEqual(["second", "third"]);
  });
});
