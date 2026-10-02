import { expect, test } from "vitest";
import { Text, visibleWidth } from "@earendil-works/pi-tui";

import {
  findTerminalMatches,
  TerminalSearchPanel,
} from "#src/plugins/pi-agent-ide-terminal/src/search.js";
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

test("bounds wrapped terminal search rows only in compact presentation", () => {
  const content = new Text(`search\n${"long output ".repeat(100)}`, 0, 0);
  const theme = { fg: (_color: string, text: string) => text };

  const compact = new TerminalSearchPanel(content, false, theme).render(40);
  const expanded = new TerminalSearchPanel(content, true, theme).render(40);

  expect(compact).toHaveLength(12);
  expect(compact.at(-1)).toContain("visual rows omitted");
  expect(expanded.length).toBeGreaterThan(compact.length);
});

test("keeps terminal search rows within the available width after resizing", () => {
  const output = Array.from(
    { length: 6 },
    (_, index) =>
      `${126 + index}: Official run: https://github.com/alexshpunt/explicit-edit-benchmark-run/actions/runs/36568016139 界`,
  ).join("\n");
  const theme = { fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[39m` };

  for (const expanded of [false, true]) {
    const panel = new TerminalSearchPanel(new Text(`search\n${output}`, 0, 0), expanded, theme);
    for (const width of [80, 39, 40, 41, 80, 40]) {
      const rows = panel.render(width);
      expect(rows.length).toBeGreaterThan(0);
      if (!expanded && width === 40) expect(rows.join("\n")).toContain("omitted");
      for (const row of rows) {
        expect(visibleWidth(row), `width ${width}: ${row}`).toBeLessThanOrEqual(width);
      }
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
