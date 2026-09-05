import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

import { generateReadExtensions } from "#tests/integration/test-stand/generate-read-extensions.js";

const generatedExtensions = await generateReadExtensions();
afterAll(() => generatedExtensions.dispose());
const generatedTempExtensions = await generateReadExtensions([
  "#tests/integration/test-stand/temp-resource-fixture-extension.ts",
]);
const generatedViewsExtensions = await generateReadExtensions([
  "#tests/integration/test-stand/views-fixture-extension.ts",
]);
afterAll(() => generatedTempExtensions.dispose());
afterAll(() => generatedViewsExtensions.dispose());
const tempRoot = path.resolve(".tmp");

test("registers read without a resolver", async () => {
  await mkdir(tempRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(tempRoot, "pi-agent-read-core-"));

  try {
    await writeFile(path.join(cwd, "fixture.txt"), "core fixture\n", "utf8");
    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-without-resolver",
      cwd,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "read", name: "read", arguments: { path: "fixture.txt" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The read call finished")]),
      ],
    }).run("Run read without a resolver");
    const message = getToolResultMessage(result, "read");

    expect(message).toMatchObject({
      toolName: "read",
      details: {
        failure: {
          code: "NO_RESOLVER",
          source: "fixture.txt",
        },
      },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reads a saved temporary result through real Pi", async () => {
  await mkdir(tempRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(tempRoot, "pi-agent-read-temp-protocol-"));

  try {
    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-temp-protocol",
      cwd,
      extensions: generatedTempExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "create-temp",
              name: "read",
              arguments: { path: "dynamic:large-fixture" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-temp",
              name: "read",
              arguments: { path: "temp:fixture-latest", offset: 2_001 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read the large dynamic fixture");
    const message = getToolResultMessage(result, "create-temp");
    const block = message.content[0];

    expect(block?.type).toBe("text");
    if (block?.type === "text") expect(block.text).toContain("Full output: temp:");
    const details = message.details;
    if (typeof details !== "object" || details === null) {
      throw new Error("Temporary read details were not returned");
    }
    expect("resolvedBy" in details ? details.resolvedBy : undefined).toBe("temp-resource-fixture");
    expect("temporarySource" in details ? details.temporarySource : undefined).toMatch(
      /^temp:[0-9a-f-]+$/u,
    );
    expect(getToolResultMessage(result, "read-temp")).toMatchObject({
      content: [{ type: "text", text: "fixture line 2001" }],
      details: { resolvedBy: "temp", startLine: 2_001, endLine: 2_001 },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("returns raw text by default even when plugin views are registered", async () => {
  await mkdir(tempRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(tempRoot, "pi-agent-read-views-raw-"));

  try {
    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-views-raw-default",
      cwd,
      extensions: generatedViewsExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read",
              name: "read",
              arguments: { path: "views-fixture:notes" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read without views returns raw text");

    expect(getToolResultMessage(result, "read")).toMatchObject({
      content: [{ type: "text", text: "alpha\nbravo\ncharlie" }],
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shows the built-in line-number column for the lines view", async () => {
  await mkdir(tempRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(tempRoot, "pi-agent-read-views-lines-"));

  try {
    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-views-lines",
      cwd,
      extensions: generatedViewsExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read",
              name: "read",
              arguments: { path: "views-fixture:notes", views: ["lines"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read with the lines view");

    expect(getToolResultMessage(result, "read")).toMatchObject({
      content: [{ type: "text", text: "1|alpha\n2|bravo\n3|charlie" }],
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("adds plugin view annotations when the request lists the view", async () => {
  await mkdir(tempRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(tempRoot, "pi-agent-read-views-plugin-"));

  try {
    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-views-plugin-view",
      cwd,
      extensions: generatedViewsExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read",
              name: "read",
              arguments: { path: "views-fixture:notes", views: ["anchors"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read with a plugin view");

    expect(getToolResultMessage(result, "read")).toMatchObject({
      content: [{ type: "text", text: "1#hash|alpha\n2#hash|bravo\n3#hash|charlie" }],
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("does not repeat a view already included by another view", async () => {
  await mkdir(tempRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(tempRoot, "pi-agent-read-views-combined-"));

  try {
    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-views-combined",
      cwd,
      extensions: generatedViewsExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read",
              name: "read",
              arguments: {
                path: "views-fixture:notes",
                views: ["anchors", "lines", "diagnostics"],
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read with combined views");

    expect(getToolResultMessage(result, "read")).toMatchObject({
      content: [
        {
          type: "text",
          text: "1#hash|alpha\n2#hash|bravo <!-- views-fixture: bravo is suspicious -->\n3#hash|charlie",
        },
      ],
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ignores unknown views and reports them in the result note and details", async () => {
  await mkdir(tempRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(tempRoot, "pi-agent-read-views-unknown-"));

  try {
    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-views-unknown",
      cwd,
      extensions: generatedViewsExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read",
              name: "read",
              arguments: { path: "views-fixture:notes", views: ["typo"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read with an unknown view");

    const message = getToolResultMessage(result, "read");
    const block = message.content[0];

    expect(block?.type).toBe("text");
    if (block?.type === "text") {
      expect(block.text.startsWith("note: ignored unknown views: typo")).toBe(true);
    }

    const details = message.details as { ignoredViews?: string[] } | undefined;
    expect(details?.ignoredViews).toEqual(["typo"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
