import { requiredValue } from "pi-agent-invariant";
import { describe, expect, test } from "vitest";

import { AstScopeManager } from "#src/api/scope.js";

import { createAstScopeAnchorResolver } from "#src/scope-resolver.js";

const manager = new AstScopeManager();
const resolver = createAstScopeAnchorResolver(manager);

describe("AST scope text anchors", () => {
  test("resolves the begin and end anchors produced for a scope", async () => {
    const context = {
      source: "scope.js",
      content:
        "function work() {\n    const first = 1;\n    const second = 2;\n    return first + second;\n}",
      lines: [
        "function work() {",
        "    const first = 1;",
        "    const second = 2;",
        "    return first + second;",
        "}",
      ],
      cwd: process.cwd(),
    };
    const scope = requiredValue(
      (await manager.getDocumentScopes(context.source, context.cwd, context.lines))[0],
    );
    expect(scope).toBeDefined();

    await expect(resolver.tryResolve(scope.beginAnchor.value, context)).resolves.toEqual({
      kind: "resolved",
      anchor: scope.beginAnchor,
    });
    await expect(resolver.tryResolve(scope.endScopeAnchor.value, context)).resolves.toEqual({
      kind: "resolved",
      anchor: scope.endScopeAnchor,
    });
  });

  test("resolves an occurrence suffix for repeated identical scopes", async () => {
    const context = {
      source: "repeated.js",
      content:
        "function repeated() {\n    const first = 1;\n    const second = 2;\n    return first + second;\n}\n\nfunction repeated() {\n    const first = 1;\n    const second = 2;\n    return first + second;\n}",
      lines: [
        "function repeated() {",
        "    const first = 1;",
        "    const second = 2;",
        "    return first + second;",
        "}",
        "",
        "function repeated() {",
        "    const first = 1;",
        "    const second = 2;",
        "    return first + second;",
        "}",
      ],
      cwd: process.cwd(),
    };
    const scopes = await manager.getDocumentScopes(context.source, context.cwd, context.lines);
    const repeated = scopes.find((scope) => scope.occurrence === 2);
    expect(repeated?.beginAnchor.value).toMatch(/-2$/u);

    await expect(
      resolver.tryResolve(requiredValue(repeated).beginAnchor.value, context),
    ).resolves.toEqual({
      kind: "resolved",
      anchor: requiredValue(repeated).beginAnchor,
    });
  });

  test("rejects stale scope anchors and ignores values outside the format", async () => {
    const context = {
      source: "scope.js",
      content: "function work() {\n    return 1;\n}",
      lines: ["function work() {", "    return 1;", "}"],
      cwd: process.cwd(),
    };
    const stale = await resolver.tryResolve("scope-begin-DEAD", context);
    expect(stale).toEqual({
      kind: "rejected",
      rejection: { code: "stale", reason: "AST scope anchor scope-begin-DEAD is stale" },
    });
    await expect(resolver.tryResolve("scope-middle-DEAD", context)).resolves.toEqual({
      kind: "not-handled",
    });
  });
});
