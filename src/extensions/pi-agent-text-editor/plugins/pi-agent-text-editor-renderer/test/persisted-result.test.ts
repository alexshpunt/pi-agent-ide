import { expect, test } from "vitest";

import { initTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { MutationPanel } from "#src/mutation-panel.js";
import { FileMutationResult } from "pi-agent-text-editor/api/mutation-result";
import { createTextDocument } from "pi-agent-text";
import { compactMutationDetails } from "#src/persisted-result.js";
import { resolveMutationResultResources } from "#src/mutation-result.js";

function result(lines: number) {
  const before = Array.from(
    { length: lines },
    (_, index) => `unchanged document line ${index}`,
  ).join("\n");
  const after = before.replace("line 5\n", "line five\n");
  return {
    results: [
      new FileMutationResult({
        ok: true,
        path: "large.txt",
        files: [{ path: "large.txt", action: "edited" }],
        beforeContentMap: { "large.txt": before },
        afterContent: after,
        afterDocument: createTextDocument("large.txt", after),
      }),
    ],
  };
}

test("stores the same diff model without whole-file snapshots or size-dependent untouched text", () => {
  const rich = result(10000);
  const compact = compactMutationDetails(rich);
  const serialized = JSON.stringify(compact);
  const restored = JSON.parse(serialized) as ReturnType<typeof compactMutationDetails>;
  expect(resolveMutationResultResources(restored, undefined).map(({ model }) => model)).toEqual(
    resolveMutationResultResources(rich, undefined).map(({ model }) => model),
  );
  expect(serialized).not.toMatch(/beforeContentMap|afterContent|afterDocument|snapshot|rawChanges/);
  expect(serialized).not.toContain("unchanged document line 9999");
  expect(serialized.length).toBeLessThan(2000);
  expect(serialized.length).toBe(JSON.stringify(compactMutationDetails(result(100))).length);
});

test("keeps restored panels identical through width and expansion changes", () => {
  initTheme("dark", false);
  const theme = Object.assign(Object.create(null) as Theme, {
    fg: (_color: ThemeColor, text: string) => `\u001b[38;2;180;180;180m${text}\u001b[39m`,
    bg: (_color: string, text: string) => `\u001b[48;2;32;37;43m${text}\u001b[49m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    getFgAnsi: () => "\u001b[38;2;180;180;180m",
    getBgAnsi: () => "\u001b[48;2;32;37;43m",
    getColorMode: () => "truecolor" as const,
  });
  const rich = result(100);
  const restored = JSON.parse(JSON.stringify(compactMutationDetails(rich))) as ReturnType<
    typeof compactMutationDetails
  >;
  const before = new MutationPanel(theme);
  const after = new MutationPanel(theme);
  before.setResultResources(resolveMutationResultResources(rich, undefined));
  after.setResultResources(resolveMutationResultResources(restored, undefined));
  for (const expanded of [false, true, false]) {
    before.setExpanded(expanded);
    after.setExpanded(expanded);
    for (const width of [160, 40, 80, 160]) {
      expect(after.render(width)).toEqual(before.render(width));
    }
  }
});
