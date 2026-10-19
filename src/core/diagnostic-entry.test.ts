import { expect, test } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { diagnosticEntryData, renderDiagnosticEntry } from "./diagnostic-entry.js";

test("one buffered delivery keeps separate tool owners and leaves unowned findings unclaimed", async () => {
  const { diagnosticEntryGroups } = await import("./diagnostic-entry.js");
  const notification = (filePath: string, parentToolCallId?: string) => ({
    filePath,
    parentToolCallId,
    text: filePath,
    results: [
      {
        source: "checker",
        status: "ready" as const,
        diagnostics: [
          { line: 1, column: 1, severity: "error" as const, code: "fixture", message: "detail" },
        ],
      },
    ],
  });
  const groups = diagnosticEntryGroups([
    notification("a.ts", "first"),
    notification("b.ts", "second"),
    notification("c.ts", "first"),
    notification("unowned.ts"),
  ]);
  expect(
    groups.map((group) => ({
      owner: group.parentToolCallId,
      files: group.files.map((file) => file.filePath),
    })),
  ).toEqual([
    { owner: "first", files: ["a.ts", "c.ts"] },
    { owner: "second", files: ["b.ts"] },
    { owner: undefined, files: ["unowned.ts"] },
  ]);
  expect(groups[2]).not.toHaveProperty("parentToolCallId");
});

test.each([false, true])(
  "entry counts preserve severity and completion status without carrying raw details (expanded=%s)",
  (expanded) => {
    const data = diagnosticEntryData({
      filePath: "src/example.ts",
      text: "hidden summary",
      results: [
        {
          source: "checker",
          status: "snapshot",
          diagnostics: (["error", "warning", "info", "hint"] as const).map((severity) => ({
            severity,
            line: 1,
            column: 1,
            code: "private-code",
            message: "private-detail",
          })),
        },
        { source: "waiting", status: "pending", diagnostics: [] },
      ],
    });
    expect(data).toEqual({
      filePath: "src/example.ts",
      sources: [
        {
          source: "checker",
          status: "snapshot",
          counts: { error: 1, warning: 1, info: 1, hint: 1 },
        },
        {
          source: "waiting",
          status: "pending",
          counts: { error: 0, warning: 0, info: 0, hint: 0 },
        },
      ],
    });
    const theme = { fg: (_color: string, value: string) => value } as Theme;
    const component = renderDiagnosticEntry(data, theme, expanded);
    for (const width of [8, 40, 100]) {
      const lines = component.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("private-detail");
      expect(lines.join("\n")).not.toContain("private-code");
      component.invalidate();
      expect(component.render(width)).toEqual(lines);
    }
  },
);

test.each([false, true])("empty stored entries render no rows (expanded=%s)", (expanded) => {
  const theme = { fg: (_color: string, value: string) => value } as Theme;
  const component = renderDiagnosticEntry(
    {
      filePath: "empty.ts",
      sources: (["pending", "unavailable", "ready", "snapshot"] as const).map((status) => ({
        source: "checker",
        status,
        counts: { error: 0, warning: 0, info: 0, hint: 0 },
      })),
    },
    theme,
    expanded,
  );
  expect(component.render(100)).toEqual([]);
});

test("collapsed entries identify each actual tool next to its findings", () => {
  const theme = { fg: (_color: string, value: string) => value } as Theme;
  const component = renderDiagnosticEntry(
    {
      filePath: "file.ts",
      sources: [
        {
          source: "typescript-language-server",
          status: "ready",
          counts: { error: 1, warning: 0, info: 0, hint: 0 },
        },
        { source: "eslint_d", status: "ready", counts: { error: 0, warning: 1, info: 0, hint: 0 } },
      ],
    },
    theme,
  );
  const output = component.render(200).join("\n");
  expect(output).toContain("(typescript-language-server)");
  expect(output).toContain("(eslint_d)");
});
