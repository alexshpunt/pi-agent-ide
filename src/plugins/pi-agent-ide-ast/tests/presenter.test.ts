import { createTextDocument } from "pi-agent-text";
import { AstScopeManager } from "#src/api/scope.js";
import { expect, test } from "vitest";

import { createAstScopePresenter } from "#src/scope-handler.js";

test("presents current AST scope markers", async () => {
  const document = createTextDocument(
    "fixture.js",
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
    source: "fixture.js",
    cwd: process.cwd(),
    resolvedBy: "filesystem",
  });
  const suffixes = presented.lines.map((line) => line.presentation?.suffix ?? "").join("\n");

  expect(suffixes).toMatch(/<!-- scope-begin-/u);
  expect(suffixes).toMatch(/<!-- scope-end-/u);
});
