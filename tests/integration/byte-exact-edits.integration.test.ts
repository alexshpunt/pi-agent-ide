import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

import { PiIntegrationTest } from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

/**
 * An ordinary-looking file with a BOM, invisible and unusual spaces, a tab indent, trailing
 * whitespace, CRLF on some lines, a lone CR, and no final line break.
 */
const BOMB = [
  "\uFEFF// routes\r\n",
  "export const routes = [\n",
  '\t{ id: "home",\u00A0retries: 1 },  \r\n',
  '  { id: "cart\u200B", retries: 2 },\t\n',
  '  { id: "checkout", retries: 3 }, // keep\rthis\r\n',
  '  { id: "search\u202F", retries: 4 },\n',
  "];\r\n",
  "export default routes;",
].join("");

test("edits through the real tools change exactly the selected bytes", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter", "ide.debugger"] }),
    );
    const file = path.join(cwd, "routes.ts");
    await writeFile(file, BOMB);
    const steps = [
      { id: "read", name: "read", arguments: { path: "routes.ts", views: ["anchors"] } },
      // A literal on a line that holds a lone CR.
      {
        id: "literal",
        name: "replace",
        arguments: { path: "routes.ts", start: "retries: 3", newText: "retries: 5" },
      },
      // A CRLF line replaced through its line anchor with LF-ended text keeps that LF.
      {
        id: "line",
        name: "replace",
        arguments: {
          path: "routes.ts",
          start: "$issued-anchor:read:3",
          newText: '\t{ id: "home", retries: 1 },\n',
        },
      },
      { id: "search", name: "search", arguments: { path: "routes.ts", query: "search\u202F" } },
      {
        id: "match",
        name: "replace",
        arguments: { path: "routes.ts", start: "$issued-searchmatch:search:1", newText: "find" },
      },
      { id: "find-cart", name: "search", arguments: { path: "routes.ts", query: "cart\u200B" } },
      { id: "line-delete", name: "delete", arguments: { start: "$issued-search:find-cart:1" } },
      // The last line has no final line break; renaming it adds none.
      {
        id: "last",
        name: "replace",
        arguments: { path: "routes.ts", start: "default routes;", newText: "default routeTable;" },
      },
      // A selector with LF where the file has CRLF is refused and changes nothing.
      {
        id: "refused",
        name: "replace",
        arguments: { path: "routes.ts", start: "];\nexport", newText: "BAD" },
      },
      // The first line keeps its BOM when the text after it changes.
      {
        id: "first",
        name: "replace",
        arguments: { path: "routes.ts", start: "// routes", newText: "// table" },
      },
    ];
    const result = await new PiIntegrationTest({
      testName: "byte-exact-edits",
      isolateUserResources: true,
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename),
      extensions: [
        path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
        path.resolve("src/pi-agent-ide.ts"),
      ],
      tools: ["read", "search", "replace", "delete"],
      conversation: [
        ...steps.map((step) =>
          assistantMessage(
            [toolCall({ ...step, chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } })],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([
          text("Done", { chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } }),
        ]),
      ],
      timeoutMs: 120_000,
    }).run("Edit routes.ts.");

    for (const step of steps.filter((item) => item.id !== "refused"))
      expect(getToolExecution(result, step.id).isError, getToolResultText(result, step.id)).toBe(
        false,
      );
    expect(getToolExecutionDetails(getToolExecution(result, "refused"))).toMatchObject({
      effect: "not-applied",
    });
    // The last edit's result shows the file's end as it is: without a final line break.
    expect(getToolResultText(result, "last")).toContain(
      "export default routeTable;\n\\ No newline at end of file",
    );
    const expected = [
      "\uFEFF// table\r\n",
      "export const routes = [\n",
      '\t{ id: "home", retries: 1 },\n',
      '  { id: "checkout", retries: 5 }, // keep\rthis\r\n',
      '  { id: "find", retries: 4 },\n',
      "];\r\n",
      "export default routeTable;",
    ].join("");
    expect((await readFile(file)).equals(Buffer.from(expected))).toBe(true);
  });
}, 180_000);
