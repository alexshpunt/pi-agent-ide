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

const fixture = "START repeated\nEND\nEND\n// BEGIN\nold\n\n// FINISH\n";
const source = "fixture.txt";
const invalidForms = {
  "legacy-start": { start: "START" },
  "legacy-end": { from: "START", end: "END" },
  "legacy-start-with-at": { start: "START", at: "START" },
  "legacy-end-with-range": { from: "START", end: "END", through: "END" },
  "at-with-range": { at: "START", from: "START", through: "END" },
  "both-starts": { from: "START", after: "// BEGIN", before: "// FINISH" },
  "both-ends": { after: "// BEGIN", through: "END", before: "// FINISH" },
  "from-alone": { from: "START" },
  "after-alone": { after: "// BEGIN" },
  "through-alone": { through: "END" },
  "before-alone": { before: "// FINISH" },
};
const read = (id: string, views?: string[]) =>
  assistantMessage(
    [toolCall({ id, name: "read", arguments: { path: source, ...(views && { views }) } })],
    { stopReason: "toolUse" },
  );
const edit = (id: string, fields: Record<string, unknown>) =>
  assistantMessage(
    [toolCall({ id, name: "replace", arguments: { path: source, text: "NEW", ...fields } })],
    { stopReason: "toolUse" },
  );

test("replace validates selector forms and pairs the only closing match after the opening one", async () => {
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
        read("read", ["anchors"]),
        ...Object.entries(invalidForms).map(([id, fields]) => edit(id, fields)),
        edit("ambiguous-first", { after: "END", before: "// FINISH" }),
        edit("ambiguous-inclusive-first", { from: "END", before: "// FINISH" }),
        edit("missing-second", { after: "// BEGIN", before: "END" }),
        read("after-refusals"),
        edit("nearest", { after: formatLineHashAnchor(fixture, 4), before: "// FINISH" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Replace the text between the markers.");
    for (const id of [
      ...Object.keys(invalidForms),
      "ambiguous-first",
      "ambiguous-inclusive-first",
      "missing-second",
    ]) {
      expect(getToolExecution(run, id).isError, id).toBe(true);
    }
    expect(getToolResultText(run, "ambiguous-inclusive-first")).not.toMatch(
      /SEARCH#[A-Z0-9]+:all:match/u,
    );
    const unchanged = getToolResultText(run, "after-refusals");
    for (const line of fixture.trimEnd().split("\n").filter(Boolean))
      expect(unchanged).toContain(line);
    expect(unchanged).not.toContain("NEW");
    expect(getToolExecution(run, "nearest").isError).toBe(false);
    await expect(readFile(file, "utf8")).resolves.toBe(
      "START repeated\nEND\nEND\n// BEGIN\nNEW\n// FINISH\n",
    );
  });
}, 90_000);

test("Codemode refuses invalid selectors and accepts Search matches as exclusive boundaries", async () => {
  await withTempWorkspace(async (cwd) => {
    const file = await createFixture(cwd, source, "left BEGIN old END right\n");
    const run = await new PiIntegrationTest({
      testName: "replace-search-exclusive-boundaries",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "read", "search", "replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "invalid-script",
              name: "codemode",
              arguments: {
                code: `
          const forms = ${JSON.stringify(invalidForms)};
          const refused = [];
          for (const [id, fields] of Object.entries(forms)) {
            try {
              if (await tools.replace({ path: ${JSON.stringify(source)}, text: "BAD", ...fields }) === null)
                refused.push(id);
            } catch {
              // A schema-invalid call can throw before reaching Replace.
              refused.push(id);
            }
          }
          text(JSON.stringify(refused));
        `,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        read("after-refusals"),
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
    expect(getToolExecution(run, "invalid-script").isError).toBe(false);
    expect(getToolResultText(run, "invalid-script")).toContain(
      JSON.stringify(Object.keys(invalidForms)),
    );
    expect(getToolResultText(run, "after-refusals")).toContain("left BEGIN old END right");
    expect(getToolExecution(run, "script").isError).toBe(false);
    expect(codemodeFailures(getToolResultText(run, "script"))).toBe("");
    await expect(readFile(file, "utf8")).resolves.toBe("left BEGIN new END right\n");
  });
}, 90_000);
