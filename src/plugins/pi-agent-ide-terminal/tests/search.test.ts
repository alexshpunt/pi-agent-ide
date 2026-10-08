import { expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderSearchMatches } from "pi-agent-search/api/search";

import { findTerminalMatches } from "#src/plugins/pi-agent-ide-terminal/src/search.js";
import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.js";

const snapshot = {
  id: "abcdef123456",
  source: "shell:abcdef123456",
  command: "printf output",
  cwd: "/workspace",
  shell: "Bash",
  shellFamily: "posix",
  background: true,
  status: "completed",
  lastActivityAt: 0,
  idleMs: 10,
  startedAt: 0,
  elapsedMs: 10,
  output: "first hidden needle\nsecond\nNEEDLE again\n",
  outputStart: 0,
  outputEnd: 45,
  truncated: false,
  fullOutputPath: "/tmp/terminal-test.log",
  cols: 80,
  rows: 24,
} satisfies TerminalSessionSnapshot;

const theme = Object.assign(Object.create(null) as Theme, {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
});
test("frames retained terminal matches and keeps compact rows bounded after resizing", () => {
  const matches = findTerminalMatches(
    { ...snapshot, output: ("needle https://example.com/界 ".repeat(30) + "\n").repeat(6) },
    { query: "needle" },
  );
  for (const expanded of [false, true]) {
    const panel = renderSearchMatches(matches, false, theme, expanded);
    for (const width of [80, 39, 40, 41, 80, 40]) {
      const rows = panel.render(width);
      expect(rows[0]).toContain("╭");
      expect(rows.join("\n")).toContain("SH");
      if (!expanded) {
        expect(rows.length).toBeLessThanOrEqual(14);
        expect(rows.join("\n")).toContain("output truncated");
      }
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    }
  }
});
test("searches all retained terminal output with normal text options", () => {
  expect(findTerminalMatches(snapshot, { query: "needle", path: snapshot.source })).toMatchObject([
    { source: snapshot.source, lineNumber: 1, startColumn: 13, matchedText: "needle" },
    { source: snapshot.source, lineNumber: 3, startColumn: 0, matchedText: "NEEDLE" },
  ]);
  expect(
    findTerminalMatches(snapshot, {
      query: "needle",
      path: snapshot.source,
      caseSensitive: true,
      wholeWord: true,
    }),
  ).toHaveLength(1);
});
