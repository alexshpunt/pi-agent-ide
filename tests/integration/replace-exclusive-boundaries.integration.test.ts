import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { expect, test } from "vitest";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const fixture = "START repeated\nEND\nEND\n// BEGIN\nold\n\n// FINISH\n// FINISH\n";
const source = "fixture.txt";
const edit = (id: string, fields: Record<string, unknown>) =>
  assistantMessage(
    [toolCall({ id, name: "replace", arguments: { path: source, text: "NEW", ...fields } })],
    { stopReason: "toolUse" },
  );

test("replace validates exclusive boundary combinations and uses the nearest closing match", async () => {
  await withTempWorkspace(async (cwd) => {
    const file = await createFixture(cwd, source, fixture);
    const run = await new PiIntegrationTest({
      testName: "replace-exclusive-boundaries",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read", "replace"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "read", name: "read", arguments: { path: source, views: ["anchors"] } })],
          { stopReason: "toolUse" },
        ),
        edit("both-starts", { start: "START", after: "// BEGIN", before: "// FINISH" }),
        edit("both-ends", { after: "// BEGIN", end: "END", before: "// FINISH" }),
        edit("after-alone", { after: "// BEGIN" }),
        edit("before-alone", { before: "// FINISH" }),
        edit("ambiguous-first", { after: "END", before: "// FINISH" }),
        edit("ambiguous-inclusive-first", { start: "END", before: "// FINISH" }),
        edit("missing-second", { after: "// BEGIN", before: "END" }),
        edit("nearest", { after: formatLineHashAnchor(fixture, 4), before: "// FINISH" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Replace the text between the markers.");
    for (const id of [
      "both-starts",
      "both-ends",
      "after-alone",
      "before-alone",
      "ambiguous-first",
      "ambiguous-inclusive-first",
      "missing-second",
    ]) {
      expect(getToolExecution(run, id).isError, id).toBe(true);
    }
    expect(getToolResultText(run, "ambiguous-inclusive-first")).not.toMatch(
      /SEARCH#[A-Z0-9]+:all:match/u,
    );
    expect(getToolExecution(run, "nearest").isError).toBe(false);
    await expect(readFile(file, "utf8")).resolves.toBe(
      "START repeated\nEND\nEND\n// BEGIN\nNEW\n// FINISH\n// FINISH\n",
    );
  });
}, 90_000);

test("replace accepts Search match values as exclusive boundaries in Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    const file = await createFixture(cwd, source, "left BEGIN old END right\n");
    const run = await new PiIntegrationTest({
      testName: "replace-search-exclusive-boundaries",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "search", "replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "script",
              name: "codemode",
              arguments: {
                code: `
          const first = await tools.search({ path: ${JSON.stringify(source)}, query: "BEGIN" });
          const last = await tools.search({ path: ${JSON.stringify(source)}, query: "END" });
          await tools.replace({ after: first.matches[0], before: last.matches[0], text: " new " });
        `,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Replace the characters between BEGIN and END using the Search matches.");
    expect(getToolExecution(run, "script").isError).toBe(false);
    expect(codemodeFailures(getToolResultText(run, "script"))).toBe("");
    await expect(readFile(file, "utf8")).resolves.toBe("left BEGIN new END right\n");
  });
}, 90_000);
