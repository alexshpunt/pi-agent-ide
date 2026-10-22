import { expect, test } from "vitest";

import { AstScopeManager } from "#src/api/scope.js";

// Each body was walked twice per level before, so this depth took about 2^26 visits and froze Pi.
test("finds every scope of a deeply nested file in linear time", async () => {
  const depth = 26;
  const lines = ["void work() {"];
  for (let level = 0; level < depth; level++) lines.push(`${"  ".repeat(level + 1)}if (a) {`);
  lines.push(`${"  ".repeat(depth + 1)}first();`, `${"  ".repeat(depth + 1)}second();`);
  for (let level = depth; level >= 0; level--) lines.push(`${"  ".repeat(level)}}`);

  const scopes = await new AstScopeManager().getDocumentScopes("nested.cpp", process.cwd(), lines);

  expect(scopes.map((scope) => scope.startLine)).toEqual(
    Array.from({ length: depth + 1 }, (_, index) => index + 1),
  );
}, 10_000);
