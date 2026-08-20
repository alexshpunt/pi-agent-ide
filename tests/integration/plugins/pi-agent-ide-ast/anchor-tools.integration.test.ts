import { readFile } from "node:fs/promises";
import path from "node:path";

import { AstScopeManager } from "pi-agent-ide-ast/api/scope";
import { getToolExecution, getToolResultText } from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import {
  expectTextToolDiff,
  runTextToolScenario,
} from "#integration/support/pi-runtime/scenario.js";

const extensions = createExtensionSet();
afterAll(() => extensions.dispose());

const lines = [
  "function first() {",
  "    const one = 1;",
  "    const two = 2;",
  "    return one + two;",
  "}",
  "",
  "function second() {",
  "    const three = 3;",
  "    const four = 4;",
  "    return three + four;",
  "}",
] as const;
const content = lines.join("\n");
const firstFunction = lines.slice(0, 5);
const secondFunction = lines.slice(6);

type AstScope = Awaited<ReturnType<AstScopeManager["getDocumentScopes"]>>[number];

describe("AST scope anchors through text editor tools", () => {
  test("inserts after an AST scope boundary", async () => {
    await runAstScenario(
      "ast-anchor-insert",
      "insert",
      ([first]) => ({ anchor: first.endScopeAnchor.value, text: "inserted();" }),
      [...firstFunction, "inserted();", "", ...secondFunction].join("\n"),
    );
  });

  test("replaces a complete AST scope", async () => {
    await runAstScenario(
      "ast-anchor-replace",
      "replace",
      ([first]) => ({
        start: first.beginAnchor.value,
        end: first.endScopeAnchor.value,
        text: "function replaced() {\n    return 0;\n}",
      }),
      ["function replaced() {", "    return 0;", "}", "", ...secondFunction].join("\n"),
    );
  });

  test("deletes a complete AST scope", async () => {
    await runAstScenario(
      "ast-anchor-delete",
      "delete",
      ([, second]) => ({
        start: second.beginAnchor.value,
        end: second.endScopeAnchor.value,
      }),
      [...firstFunction, ""].join("\n"),
    );
  });

  test("copies an AST scope after another AST scope", async () => {
    await runAstScenario(
      "ast-anchor-copy",
      "copy",
      ([first, second]) => ({
        start: first.beginAnchor.value,
        end: first.endScopeAnchor.value,
        targetStart: second.endScopeAnchor.value,
      }),
      [...lines, ...firstFunction].join("\n"),
    );
  });

  test("cuts an AST scope after another AST scope", async () => {
    await runAstScenario(
      "ast-anchor-move",
      "move",
      ([first, second]) => ({
        start: first.beginAnchor.value,
        end: first.endScopeAnchor.value,
        targetStart: second.endScopeAnchor.value,
      }),
      ["", ...secondFunction, ...firstFunction].join("\n"),
    );
  });
});

async function runAstScenario(
  testName: string,
  tool: "insert" | "replace" | "delete" | "copy" | "move",
  buildArguments: (scopes: readonly AstScope[]) => Record<string, unknown>,
  expectedContent: string,
): Promise<void> {
  await withTempWorkspace(async (directory) => {
    const file = await createFixture(directory, `${tool}.js`, content);
    const relativeFile = path.relative(directory, file);
    const scopes = await new AstScopeManager().getDocumentScopes(relativeFile, directory, lines);
    expect(scopes).toHaveLength(2);

    const anchorArguments = buildArguments(scopes);
    const expectedAnchors = Object.entries(anchorArguments)
      .filter(
        ([key, value]) =>
          ["targetStart", "start", "end"].includes(key) && typeof value === "string",
      )
      .map(([, value]) => value as string);
    const toolArguments =
      tool === "copy" || tool === "move"
        ? { path: relativeFile, target: relativeFile, ...anchorArguments }
        : { path: relativeFile, ...anchorArguments };
    const scenario = await runTextToolScenario({
      extensions: extensions.paths,
      cwd: directory,
      testName,
      tool,
      arguments: toolArguments,
    });
    const { result, mutationCallId, preflightCallIds } = scenario;
    const preflight = preflightCallIds.map((id) => getToolResultText(result, id)).join("\n");

    for (const expectedAnchor of expectedAnchors) {
      expect(preflight).toContain(expectedAnchor);
    }

    expect(getToolExecution(result, mutationCallId).isError).toBe(false);
    expectTextToolDiff(scenario, relativeFile, content, expectedContent);
    expect(getToolResultText(result, mutationCallId)).toMatch(/<!-- scope-(?:begin|end)-/u);
    await expect(readFile(file, "utf8")).resolves.toBe(expectedContent);
  });
}
