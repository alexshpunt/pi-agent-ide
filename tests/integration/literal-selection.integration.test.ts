import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, test } from "vitest";
import { textLineAnchors } from "pi-agent-text";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.ts";

const extensions = createExtensionSet();
const tempRoot = path.resolve(".agents/tmp/literal-selection");
const runtimeAnchors = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
);
const content = "// PREFIX\n// BEGIN block\nbody line\n// END block\n// SUFFIX\n";

// Literal text selects only its characters, even a complete line; a :line reference keeps lines.
test("literal selectors edit exact characters while :line references edit whole lines", async () => {
  await mkdir(tempRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(tempRoot, "run-"));
  try {
    for (const name of ["insert-literal", "delete-literal", "insert-line", "delete-line"])
      await writeFile(path.join(cwd, `${name}.txt`), content);
    const calls = [
      {
        id: "insert-literal",
        name: "insert",
        arguments: { path: "insert-literal.txt", anchor: "// END block", text: "// X" },
      },
      {
        id: "delete-literal",
        name: "delete",
        arguments: { path: "delete-literal.txt", start: "body line" },
      },
      {
        id: "search-insert",
        name: "search",
        arguments: { path: "insert-line.txt", query: "// END block" },
      },
      {
        id: "insert-line",
        name: "insert",
        arguments: { path: "insert-line.txt", anchor: "SEARCH#RUNTIME:1:1:line", text: "// X" },
      },
      {
        id: "search-delete",
        name: "search",
        arguments: { path: "delete-line.txt", query: "body line" },
      },
      {
        id: "delete-line",
        name: "delete",
        arguments: { path: "delete-line.txt", start: "SEARCH#RUNTIME:2:1:line" },
      },
    ];
    await new PiIntegrationTest({
      testName: "literal-selection",
      artifactsDir: testArtifactsDir(import.meta.filename),
      isolateUserResources: true,
      cwd,
      extensions: [...extensions.paths, runtimeAnchors],
      tools: ["search", "insert", "delete"],
      conversation: [
        ...calls.map((call) => assistantMessage([toolCall(call)], { stopReason: "toolUse" })),
        assistantMessage([text("Done")]),
      ],
    }).run("Edit the block markers with literal and :line selectors.");
    const read = (name: string) => readFile(path.join(cwd, `${name}.txt`), "utf8");
    expect(await read("insert-literal")).toBe(content.replace("// END block", "// END block// X"));
    expect(await read("delete-literal")).toBe(content.replace("body line", ""));
    expect(await read("insert-line")).toBe(
      content.replace("// END block\n", "// END block\n// X\n"),
    );
    expect(await read("delete-line")).toBe(content.replace("body line\n", ""));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Read anchors view text selects source characters in a real edit", async () => {
  await mkdir(tempRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(tempRoot, "run-"));
  const source = path.join(cwd, "fixture.txt");
  const original = "keep this\r\nchange this part\r\nkeep that";
  try {
    await writeFile(source, original);
    const anchor = textLineAnchors(source, original)[1];
    const selector = `${anchor}|change this`.slice(3);
    await new PiIntegrationTest({
      testName: "copied-anchored-view",
      artifactsDir: testArtifactsDir(import.meta.filename),
      isolateUserResources: true,
      cwd,
      extensions: extensions.paths,
      tools: ["read", "replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-anchors",
              name: "read",
              arguments: { path: "fixture.txt", views: ["anchors"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "replace-copy",
              name: "replace",
              arguments: { path: "fixture.txt", start: selector, text: "edited" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read the middle line with its anchor, then edit only the selected phrase.");
    expect(await readFile(source, "utf8")).toBe("keep this\r\nedited part\r\nkeep that");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
