import { expect, test } from "vitest";
import { summarizeStatuses } from "#src/status-summary.js";

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
    statuses: [{ status: failed, paths: ["d.py"] }],
  });
});
