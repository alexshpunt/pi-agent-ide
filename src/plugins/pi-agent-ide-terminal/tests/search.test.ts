import { expect, test } from "vitest";

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
  startedAt: 0,
  elapsedMs: 10,
  output: "first hidden needle\nsecond\nNEEDLE again\n",
  outputStart: 0,
  outputEnd: 45,
  truncated: false,
  cols: 80,
  rows: 24,
} satisfies TerminalSessionSnapshot;

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
