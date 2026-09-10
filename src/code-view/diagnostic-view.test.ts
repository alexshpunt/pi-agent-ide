import { expect, test } from "vitest";

import { createTextDocument, renderTextDocument } from "pi-agent-text";
import { addDiagnosticAnnotations, createDiagnosticViewContent } from "./diagnostic-view.js";

test.each(["pending", "unavailable", "snapshot", "unversioned"] as const)(
  "%s diagnostic reports never look clean",
  (status) => {
    const sources = [{ source: "lsp", status, diagnostics: [] }];
    const focused = createDiagnosticViewContent("example.ts", "line\n", sources);
    expect(focused.diagnosticCheck).toEqual({ complete: false, count: 0, sources: ["lsp"] });
  },
);

const diagnostic = (line: number, code: string) => ({
  code,
  message: `problem ${code}`,
  line,
  column: 1,
  severity: "error" as const,
});

test.each(["\n", "\r\n"])(
  "keeps EOF diagnostics visible without changing source lines (%j)",
  (ending) => {
    const content = `value: [${ending}`;
    const report = diagnostic(2, "EOF_PARSE");
    const document = addDiagnosticAnnotations(createTextDocument("config.yaml", content), [
      { source: "lsp", diagnostics: [report] },
    ]);
    expect(document.lines).toHaveLength(1);
    expect(document.lines[0]?.presentation?.suffix).toContain("lsp:EOF_PARSE");
    expect(document.lines[0]?.presentation?.suffix).toContain("@2:1");
    expect(report.line).toBe(2);
    expect(renderTextDocument(document)).toBe(content);
  },
);

test("diagnostic reads include and merge five lines of surrounding context", () => {
  const text = Array.from({ length: 20 }, (_, index) => `line ${String(index + 1)}`).join("\n");

  const content = createDiagnosticViewContent(
    "sample.ts",
    text,
    [
      { source: "lsp", diagnostics: [diagnostic(7, "LSP7")] },
      { source: "lint", diagnostics: [diagnostic(11, "LINT11")] },
    ],
    { contextLines: 5 },
  );

  const lines = content.text.split("\n");
  expect(lines).toHaveLength(15);
  expect(lines[0]).toBe("line 2");
  expect(lines.at(-1)).toBe("line 16");
  expect(lines.filter((line) => line === "line 8")).toHaveLength(1);
  expect(lines[5]).toContain("<!-- lsp: [ERROR] lsp:LSP7:");
  expect(lines[9]).toContain("<!-- lint: [ERROR] lint:LINT11:");
  expect(content.sourceLines).toMatchObject({
    "1": { source: "sample.ts", lineNumber: 2, content: "line 2" },
    "15": { source: "sample.ts", lineNumber: 16, content: "line 16" },
  });
});

test("diagnostic reads keep provider labels when providers report the same line", () => {
  const content = createDiagnosticViewContent("sample.ts", "one\ntwo\nthree", [
    { source: "lsp", diagnostics: [diagnostic(2, "LSP2")] },
    { source: "lint", diagnostics: [diagnostic(2, "LINT2")] },
  ]);

  expect(content.text).toContain("<!-- lsp: [ERROR] lsp:LSP2:");
  expect(content.text).toContain("<!-- lint: [ERROR] lint:LINT2:");
});

test("completed clean checks carry their sources and an explicit completion state", () => {
  const content = createDiagnosticViewContent("sample.ts", "", [
    { source: "typescript", status: "ready", diagnostics: [] },
    { source: "oxlint", status: "ready", diagnostics: [] },
  ]);
  expect(content.diagnosticCheck).toEqual({
    complete: true,
    count: 0,
    sources: ["typescript", "oxlint"],
  });
});

test.each([undefined, "snapshot", "pending", "unavailable"] as const)(
  "empty %s checks do not become completed clean reports",
  (status) => {
    const content = createDiagnosticViewContent("sample.ts", "", [
      { source: "typescript", status, diagnostics: [] },
    ]);
    expect(content.diagnosticCheck.complete).toBe(false);
    expect(createDiagnosticViewContent("sample.ts", "", []).diagnosticCheck.complete).toBe(false);
  },
);
