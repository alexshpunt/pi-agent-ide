import { expect, test } from "vitest";

import { createDiagnosticViewContent } from "./diagnostic-view.js";

test.each(["pending", "unavailable", "snapshot", "unversioned"] as const)(
  "%s diagnostic reports never look clean",
  (status) => {
    const sources = [{ source: "lsp", status, diagnostics: [] }];
    const focused = createDiagnosticViewContent("example.ts", "line\n", sources);
    expect(focused.text).toContain(`lsp: ${status}`);
    expect(focused.text).not.toContain("No diagnostics");
  },
);

const diagnostic = (line: number, code: string) => ({
  code,
  message: `problem ${code}`,
  line,
  column: 1,
  severity: "error" as const,
});

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
