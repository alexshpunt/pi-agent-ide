import { createTextDocument } from "pi-agent-text";
import { AstScopeManager } from "#src/api/scope.js";
import { expect, test } from "vitest";

import { createAstScopePresenter } from "#src/scope-handler.js";

test.each([
  { source: "fixture.js", resolvedBy: "filesystem" },
  { source: "ssh://fixture/work/fixture.js", resolvedBy: "ssh" },
])(
  "presents current AST scope markers for $resolvedBy snapshots",
  async ({ source, resolvedBy }) => {
    const document = createTextDocument(
      source,
      [
        "function alpha() {",
        "    const first = 1;",
        "    const second = 2;",
        "    return first + second;",
        "}",
      ].join("\n"),
    );
    const presented = await createAstScopePresenter(new AstScopeManager()).present(document, {
      purpose: "edit-diff",
      source,
      cwd: process.cwd(),
      resolvedBy,
    });
    const suffixes = presented.lines.map((line) => line.presentation?.suffix ?? "").join("\n");

    expect(suffixes).toMatch(/<!-- scope-begin-/u);
    expect(suffixes).toMatch(/<!-- scope-end-/u);
  },
);
