import { describe, expect, it } from "vitest";

import { parseDiagnostics } from "./diagnostics.js";

describe("linter diagnostic adapters", () => {
  it("counts ESLint numeric errors separately from warnings", () => {
    const output = JSON.stringify([
      {
        messages: [
          { line: 1, column: 1, severity: 2, message: "error" },
          { line: 2, column: 1, severity: 1, message: "warning" },
        ],
      },
    ]);
    expect(
      parseDiagnostics(output, { format: "eslint-json" }).map((item) => item.severity),
    ).toEqual(["error", "warning"]);
  });
  it("parses Clang diagnostics", () => {
    expect(
      parseDiagnostics("main.cpp:4:9: warning: use nullptr [modernize-use-nullptr]", {
        format: "clang",
      }),
    ).toEqual([
      {
        code: "modernize-use-nullptr",
        message: "use nullptr",
        line: 4,
        column: 9,
        severity: "warning",
      },
    ]);
  });

  it("parses the public JSON adapter", () => {
    expect(
      parseDiagnostics(
        JSON.stringify({
          diagnostics: [{ line: 2, column: 3, severity: "error", code: "X1", message: "broken" }],
        }),
        { format: "pi-json" },
      ),
    ).toMatchObject([{ code: "X1", line: 2, severity: "error" }]);
  });

  it("parses Oxlint SARIF diagnostics", () => {
    expect(
      parseDiagnostics(
        JSON.stringify({
          runs: [
            {
              results: [
                {
                  ruleId: "eslint(no-debugger)",
                  level: "error",
                  message: { text: "debugger is not allowed" },
                  locations: [
                    {
                      physicalLocation: {
                        region: { startLine: 4, startColumn: 2 },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
        { format: "sarif" },
      ),
    ).toEqual([
      {
        code: "eslint(no-debugger)",
        message: "debugger is not allowed",
        line: 4,
        column: 2,
        severity: "error",
      },
    ]);
  });
  it("parses Checkstyle XML", () => {
    const output =
      '<checkstyle><file name="Main.java"><error line="7" column="2" severity="error" message="Use braces" source="NeedBraces"/></file></checkstyle>';
    expect(parseDiagnostics(output, { format: "checkstyle" })).toMatchObject([
      {
        code: "NeedBraces",
        line: 7,
        column: 2,
        severity: "error",
      },
    ]);
  });

  it("parses named-group regex adapters", () => {
    const output = "file.py:3:5: F401 unused import";
    const pattern = "^(?<file>.+?):(?<line>\\d+):(?<column>\\d+): (?<code>\\S+) (?<message>.+)$";
    expect(parseDiagnostics(output, { format: "regex", pattern })).toMatchObject([
      {
        code: "F401",
        line: 3,
        column: 5,
      },
    ]);
  });
});
