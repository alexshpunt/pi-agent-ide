import { homedir } from "node:os";

import { VERSION } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import {
  MAX_ISSUE_URL_LENGTH,
  problemKey,
  problemReport,
  type ProblemSource,
} from "pi-problem-report";

const source: ProblemSource = {
  name: "sample-extension",
  version: "9.8.7",
  issuesUrl: "https://github.com/example/sample-extension/issues",
};

function bodyOf(url: string): string {
  return new URL(url).searchParams.get("body") ?? "";
}

test("a report link opens the source's new-issue form with the error, stack, context and versions", () => {
  const error = new Error("BROKEN STATE");
  error.stack = [
    "Error: BROKEN STATE",
    "    at first (/pkg/src/a.ts:1:1)",
    "    at second (/pkg/src/b.ts:2:2)",
  ].join("\n");
  const report = problemReport(source, {
    summary: "SUMMARY",
    error,
    context: ["Module: CONTEXT-MODULE"],
  });
  const url = new URL(report.url);
  expect(url.origin + url.pathname).toBe(`${source.issuesUrl}/new`);
  expect(url.searchParams.get("title")).toBe("BROKEN STATE");
  const body = bodyOf(report.url);
  expect(body).toBe(report.body);
  for (const part of [
    "SUMMARY",
    "at first (/pkg/src/a.ts:1:1)",
    "at second (/pkg/src/b.ts:2:2)",
    "CONTEXT-MODULE",
    source.name,
    source.version,
    VERSION,
  ])
    expect(body).toContain(part);
});

test("a trailing slash in the issues URL does not double the separator", () => {
  const report = problemReport({ ...source, issuesUrl: `${source.issuesUrl}/` }, { summary: "S" });
  expect(new URL(report.url).pathname).toBe(`${new URL(source.issuesUrl).pathname}/new`);
});

test("a report leaves out the user's home folder from the stack, message and context", () => {
  const home = homedir();
  const error = new Error(`cannot open ${home}/project/file.ts`);
  error.stack = `Error: HOME\n    at frame (${home}/.pi/agent/npm/node_modules/sample/src/a.ts:1:1)`;
  const { body, url } = problemReport(source, {
    summary: "S",
    error,
    context: [`Workspace: ${home}/project`],
  });
  expect(body).not.toContain(home);
  expect(bodyOf(url)).not.toContain(home);
  expect(body).toContain("at frame (~/.pi/agent/npm/node_modules/sample/src/a.ts:1:1)");
  expect(body).toContain("~/project");
});

test("the lines of a multi-line message appear once, not again among the stack frames", () => {
  const error = new Error("FIRST LINE\nSECOND LINE");
  error.stack = "Error: FIRST LINE\nSECOND LINE\n    at frame (/sample/a.ts:1:1)";
  const { body } = problemReport(source, { summary: "S", error });
  expect(body.split("SECOND LINE")).toHaveLength(2);
  expect(body).toContain("at frame (/sample/a.ts:1:1)");
});

test("a long stack loses its last frames in the link, while the copied report keeps them", () => {
  const error = new Error("DEEP");
  const frames = Array.from(
    { length: 15 },
    (_, index) => `    at frame${index} (/${"x".repeat(900)}/file.ts:${index}:1)`,
  );
  error.stack = ["Error: DEEP", ...frames].join("\n");
  const report = problemReport(source, { summary: "S", error });
  expect(report.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
  const body = bodyOf(report.url);
  expect(body).toContain("at frame0 ");
  expect(body).not.toContain("at frame14 ");
  expect(report.body).toContain("at frame14 ");
});

test("a long message is shortened in the link, while the copied report keeps it whole", () => {
  // Emoji are surrogate pairs; a cut between their halves would make the link unbuildable.
  const message = `HUGE ${"😀".repeat(5000)} END`;
  const report = problemReport(source, { summary: "S", error: new Error(message) });
  expect(report.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
  expect(bodyOf(report.url)).toContain("HUGE ");
  expect(bodyOf(report.url)).not.toContain(" END");
  expect(report.body).toContain(message);
});

test("a problem without an error is reported by its summary", () => {
  const report = problemReport(source, { summary: "UNSUPPORTED HOST" });
  expect(report.title).toBe("UNSUPPORTED HOST");
  expect(bodyOf(report.url)).toContain("UNSUPPORTED HOST");
});

test("non-Error values still give a report title", () => {
  expect(problemReport(source, { summary: "S", error: "PLAIN STRING" }).title).toBe("PLAIN STRING");
  expect(problemReport(source, { summary: "S", error: { code: 7 } }).title).toContain("7");
  expect(problemReport(source, { summary: "S", error: { message: "FOREIGN" } }).title).toBe(
    "FOREIGN",
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(problemReport(source, { summary: "S", error: circular }).title.length).toBeGreaterThan(0);
});

test("a problem's key defaults to its summary and error and can be set explicitly", () => {
  expect(problemKey({ summary: "S", error: new Error("A") })).toBe(
    problemKey({ summary: "S", error: new Error("A") }),
  );
  expect(problemKey({ summary: "S", error: new Error("A") })).not.toBe(
    problemKey({ summary: "S", error: new Error("B") }),
  );
  expect(problemKey({ summary: "S", key: "K" })).toBe("K");
});
