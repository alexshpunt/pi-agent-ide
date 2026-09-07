import { describe, expect, it } from "vitest";

import { parseDiagnostics } from "./diagnostics.js";

import { LINTER_RECIPES } from "./catalog.js";
import { requiredValue } from "pi-agent-invariant";

describe("linter diagnostic adapters", () => {
  it("parses JSONLint syntax errors and their columns", () => {
    const recipe = requiredValue(LINTER_RECIPES.find((item) => item.id === "jsonlint")?.linter);
    expect(
      parseDiagnostics(
        'Parse error on line 1, column 13:\r\n{"enabled": }\r\nNo value found for key "enabled"',
        {
          format: "regex",
          pattern: requiredValue(recipe.diagnostics.pattern),
        },
      ),
    ).toMatchObject([{ line: 1, column: 13, severity: "error" }]);
  });
  it("parses multiline native reports with CRLF and preserves drive-letter paths", () => {
    const recipe = requiredValue(LINTER_RECIPES.find((item) => item.id === "taplo-check")?.linter);
    const diagnostics = parseDiagnostics(
      "error: conflicting keys\r\n  ┌─ C:\\project with spaces\\config.toml:3:1\r\n",
      { format: "regex", pattern: requiredValue(recipe.diagnostics.pattern) },
    );
    expect(diagnostics).toMatchObject([
      { file: "C:\\project with spaces\\config.toml", line: 3, column: 1, severity: "error" },
    ]);
  });
  it("converts CMake zero-based columns into one-based diagnostics", () => {
    const recipe = requiredValue(LINTER_RECIPES.find((item) => item.id === "cmake-lint")?.linter);
    expect(
      parseDiagnostics(
        "CMakeLists.txt:03,00: [C0111] Missing docstring\nCMakeLists.txt:03,09: [C0103] Invalid name\n",
        {
          format: "regex",
          pattern: requiredValue(recipe.diagnostics.pattern),
          columnBase: recipe.diagnostics.columnBase,
        },
      ),
    ).toMatchObject([
      { line: 3, column: 1 },
      { line: 3, column: 10 },
    ]);
  });
  it("keeps RuboCop error severity and Windows file locations", () => {
    const recipe = requiredValue(LINTER_RECIPES.find((item) => item.id === "rubocop")?.linter);
    expect(
      parseDiagnostics("C:\\project with spaces\\main.rb:2:3: E: Lint/Syntax: unexpected token", {
        format: "regex",
        pattern: requiredValue(recipe.diagnostics.pattern),
      }),
    ).toMatchObject([
      {
        file: "C:\\project with spaces\\main.rb",
        code: "Lint/Syntax",
        line: 2,
        column: 3,
        severity: "error",
      },
    ]);
  });
  it("keeps project-wide diagnostic locations and decodes numeric XML entities", () => {
    const output =
      '<checkstyle><file name="src/main.go"><error line="3" column="2" severity="error" message="wrong &#34;type&#34;" source="govet"/></file><file name="src/other.go"><error line="9" message="other" source="govet"/></file></checkstyle>';
    expect(parseDiagnostics(output, { format: "checkstyle" })).toMatchObject([
      { file: "src/main.go", line: 3, message: 'wrong "type"' },
      { file: "src/other.go", line: 9 },
    ]);
  });
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
        file: "main.cpp",
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
