import { lineAnchors, linesWithAnchor } from "pi-agent-text";
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

  test("resolves a scope wherever the line anchor of its first line resolves", async () => {
    // Which edits keep a repeated line's anchor is up to the line anchors; a scope follows them.
    const repeated = [
      "function repeated() {",
      "    const first = 1;",
      "    const second = 2;",
      "    return first + second;",
      "}",
    ];
    const alpha = ["function alpha() {", "    log('a');", "    log('b');", "    log('c');", "}"];
    const beta = ["function beta() {", "    return 2;", "}"];
    const original = [...repeated, "", ...alpha, "", ...repeated, "", ...beta];
    const edits = {
      "identical scope moved past its copy": [
        ...alpha,
        "",
        ...repeated,
        "",
        ...repeated,
        "",
        ...beta,
      ],
      "copy inserted": [...repeated, "", ...repeated, "", ...alpha, "", ...repeated, "", ...beta],
      "unique scope moved": [...beta, "", ...repeated, "", ...alpha, "", ...repeated],
      "line added inside": [...repeated.slice(0, 1), "    log('x');", ...original.slice(1)],
    };
    const before = context("repeated.js", original);
    const scopes = (
      await manager.getDocumentScopes(before.source, before.cwd, before.lines)
    ).filter((scope) => scope.depth === 0);
    const firstLineAnchors = lineAnchors(original);
    const outcomes = new Set<string>();

    for (const [edit, lines] of Object.entries(edits)) {
      const after = context("repeated.js", lines);
      const afterScopes = await manager.getDocumentScopes(after.source, after.cwd, after.lines);
      for (const scope of scopes) {
        const found = linesWithAnchor(
          lineAnchors(lines),
          requiredValue(firstLineAnchors[scope.startLine - 1]),
        );
        const outcome = await resolver.tryResolve(scope.endScopeAnchor.value, after);
        const label = `${edit}: scope at line ${scope.startLine}`;
        if (found.length === 1) {
          const target = requiredValue(afterScopes.find((each) => each.startLine === found[0]));
          expect(outcome, label).toMatchObject({
            kind: "resolved",
            anchor: { lineNumber: target.endLine },
          });
          outcomes.add("resolved");
        } else {
          expect(outcome, label).toMatchObject({ kind: "rejected", rejection: { code: "stale" } });
          outcomes.add("stale");
        }
      }
    }
    // The edits cover both outcomes, so the contract is checked in both directions.
    expect([...outcomes].sort()).toEqual(["resolved", "stale"]);
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
