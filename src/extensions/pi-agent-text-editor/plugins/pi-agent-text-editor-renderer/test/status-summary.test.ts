import { expect, test } from "vitest";
import { summarizeStatuses } from "#src/status-summary.js";

test.each(["disabled", "deferred"] as const)(
  "does not claim formatting ran for a known %s state",
  (formattingStatus) => {
    const status = {
      text: "Plugin status",
      formatter: "fixture",
      tone: "success" as const,
      formattingStatus,
    };
    const summary = summarizeStatuses([{ path: "file.note", diffStatuses: [status] }]);
    expect(summary.formatted).toEqual([]);
    expect(summary.alreadyFormatted).toEqual([]);
    expect(summary.statuses).toEqual([{ status, paths: ["file.note"] }]);
  },
);

test("already formatted files stay separate from changed formatting and other checks", () => {
  const check = { text: "Extra check finished", tone: "muted" as const };
  expect(
    summarizeStatuses([
      {
        path: "changed.note",
        diffStatuses: [
          { text: "Formatted", formatter: "fixture", tone: "success", formattingStatus: "changed" },
        ],
      },
      {
        path: "unchanged.note",
        diffStatuses: [
          {
            text: "Already formatted",
            formatter: "fixture",
            tone: "success",
            formattingStatus: "unchanged",
          },
          check,
        ],
      },
      {
        path: "unchanged.note",
        diffStatuses: [
          {
            text: "Already formatted",
            formatter: "fixture",
            tone: "success",
            formattingStatus: "unchanged",
          },
        ],
      },
    ]),
  ).toEqual({
    formatted: ["changed.note"],
    formatters: ["fixture"],
    alreadyFormatted: ["unchanged.note"],
    unchangedFormatters: ["fixture"],
    statuses: [{ status: check, paths: ["unchanged.note"] }],
  });
});

test("formatter summaries count unique files and tools while retaining failures", () => {
  const format = (formatter: string) => ({
    text: "formatted",
    tone: "success" as const,
    formatter,
  });
  const failed = { text: "failed", tone: "error" as const };
  expect(
    summarizeStatuses([
      { path: "a.ts", diffStatuses: [format("oxfmt"), format("oxfmt")] },
      { path: "b.ts", diffStatuses: [format("oxfmt")] },
      { path: "c.py", diffStatuses: [format("ruff")] },
      { path: "d.py", diffStatuses: [failed, failed] },
    ]),
  ).toEqual({
    formatted: ["a.ts", "b.ts", "c.py"],
    formatters: ["oxfmt", "ruff"],
    alreadyFormatted: [],
    unchangedFormatters: [],
    statuses: [{ status: failed, paths: ["d.py"] }],
  });
});
