import { lineAnchors } from "pi-agent-text";
import { requiredValue } from "pi-agent-invariant";
import { describe, expect, test } from "vitest";

import { AstScopeManager } from "#src/api/scope.ts";

import { createAstScopeAnchorResolver } from "#src/scope-resolver.ts";

const manager = new AstScopeManager();
const resolver = createAstScopeAnchorResolver(manager);

function context(source: string, lines: readonly string[]) {
  return { source, content: lines.join("\n"), lines, cwd: process.cwd() };
}

async function scopeStartingWith(snapshot: ReturnType<typeof context>, firstLine: string) {
  const scopes = await manager.getDocumentScopes(snapshot.source, snapshot.cwd, snapshot.lines);
  return requiredValue(scopes.find((scope) => snapshot.lines[scope.startLine - 1] === firstLine));
}

const work = [
  "function work() {",
  "    const first = 1;",
  "    const second = 2;",
  "    return first + second;",
  "}",
];

describe("AST scope text anchors", () => {
  test("names a scope by the line anchor of its first line", async () => {
    const snapshot = context("scope.js", work);
    const scope = await scopeStartingWith(snapshot, "function work() {");
    const anchor = requiredValue(lineAnchors(work)[0]);

    expect(scope.beginAnchor.value).toBe(`scope-begin-${anchor}`);
    expect(scope.endScopeAnchor.value).toBe(`scope-end-${anchor}`);
    await expect(resolver.tryResolve(scope.beginAnchor.value, snapshot)).resolves.toEqual({
      kind: "resolved",
      anchor: scope.beginAnchor,
    });
    await expect(resolver.tryResolve(scope.endScopeAnchor.value, snapshot)).resolves.toEqual({
      kind: "resolved",
      anchor: scope.endScopeAnchor,
    });
  });

  test("keeps resolving after an edit inside the scope", async () => {
    const before = await scopeStartingWith(context("scope.js", work), "function work() {");
    const edited = context("scope.js", [
      "function work() {",
      "    const first = 10;",
      "    const extra = 3;",
      "    const second = 2;",
      "    return first + second + extra;",
      "}",
    ]);

    await expect(resolver.tryResolve(before.endScopeAnchor.value, edited)).resolves.toMatchObject({
      kind: "resolved",
      anchor: { lineNumber: 6 },
    });
  });

  test("keeps naming the same one of two identical scopes after the other moves past it", async () => {
    const repeated = [
      "function repeated() {",
      "    const first = 1;",
      "    const second = 2;",
      "    return first + second;",
      "}",
    ];
    const alpha = ["function alpha() {", "    log('a');", "    log('b');", "    log('c');", "}"];
    const original = context("repeated.js", [...repeated, "", ...alpha, "", ...repeated]);
    const scopes = await manager.getDocumentScopes(original.source, original.cwd, original.lines);
    const [first, second] = scopes.filter(
      (scope) => scope.startLine === 1 || scope.startLine === 13,
    );
    expect(requiredValue(first).beginAnchor.value).not.toBe(
      requiredValue(second).beginAnchor.value,
    );

    // Another session moves the first copy to the end, past the second, which now ends on line 11.
    const moved = context("repeated.js", [...alpha, "", ...repeated, "", ...repeated]);

    await expect(
      resolver.tryResolve(requiredValue(second).endScopeAnchor.value, moved),
    ).resolves.toMatchObject({ kind: "resolved", anchor: { lineNumber: 11 } });
    const movedCopy = await resolver.tryResolve(requiredValue(first).endScopeAnchor.value, moved);
    expect(movedCopy).not.toMatchObject({ anchor: { lineNumber: 11 } });
  });

  test("rejects an anchor as stale once the scope's first line changes", async () => {
    const before = await scopeStartingWith(context("scope.js", work), "function work() {");
    const renamed = context("scope.js", ["function labour() {", ...work.slice(1)]);

    await expect(resolver.tryResolve(before.beginAnchor.value, renamed)).resolves.toEqual({
      kind: "rejected",
      rejection: {
        code: "stale",
        reason: `AST scope anchor ${before.beginAnchor.value} is stale`,
      },
    });
  });

  test("rejects anchors in the earlier hash format as stale and ignores other values", async () => {
    const snapshot = context("scope.js", ["function work() {", "    return 1;", "}"]);
    for (const value of ["scope-begin-DEAD", "scope-end-1A2B-2"]) {
      await expect(resolver.tryResolve(value, snapshot)).resolves.toEqual({
        kind: "rejected",
        rejection: { code: "stale", reason: `AST scope anchor ${value} is stale` },
      });
    }
    await expect(resolver.tryResolve("scope-middle-DEAD", snapshot)).resolves.toEqual({
      kind: "not-handled",
    });
  });
});
