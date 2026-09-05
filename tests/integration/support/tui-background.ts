import { expect } from "vitest";

/** Checks that matching raw Pi terminal rows are enclosed by a tool background. */
export function expectToolRowsHaveBackground(terminalOutput: string, marker: string): void {
  const rows = terminalOutput.split("\u001B[2K").filter((row) => {
    const markerAt = row.indexOf(marker);
    return (
      markerAt !== -1 &&
      /\u001B\[48(?:;\d+)+m/u.test(row.slice(0, markerAt)) &&
      row.lastIndexOf("\u001B[49m\u001B[0m") > markerAt
    );
  });

  expect(rows.length).toBeGreaterThan(0);
}

/** Checks raw Pi terminal rows for child resets and returns their enclosing backgrounds. */
export function expectToolRowsPreserveBackground(
  terminalOutput: string,
  marker: string,
): readonly string[] {
  const resetPattern = /\u001B\[(?:0|49)?m/gu;
  const backgrounds: string[] = [];
  let checkedResets = 0;

  for (const row of terminalOutput.split("\u001B[2K")) {
    if (!row.includes(marker)) {
      continue;
    }

    const enclosingBackground = row.match(/\u001B\[48(?:;\d+)+m/u)?.[0];
    const shellReset = row.lastIndexOf("\u001B[49m\u001B[0m");
    if (enclosingBackground === undefined || shellReset === -1) {
      continue;
    }

    const child = row.slice(0, shellReset);
    backgrounds.push(enclosingBackground);
    for (const reset of child.matchAll(resetPattern)) {
      checkedResets++;
      const suffix = child.slice(reset.index + reset[0].length);
      expect(suffix.startsWith(enclosingBackground)).toBe(true);
    }
  }

  expect(checkedResets).toBeGreaterThan(0);
  return backgrounds;
}
