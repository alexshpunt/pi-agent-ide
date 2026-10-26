import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { FIXTURE_FRAMES } from "#integration/support/image-classifier-fixture.js";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const colour = `{colour:{type:"choice",instructions:"Which colour is the image?",criteria:{red:"Red pixels",unknown:"Anything else"}}}`;

async function runScripts(cwd: string, name: string, scripts: readonly string[]) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  await writeFile(path.join(cwd, "pixel.png"), pixel);
  await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n");
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    cwd,
    extensions: [
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
      path.resolve("tests/integration/support/image-classifier-fixture.ts"),
    ],
    tools: ["read", "search", "codemode"],
    conversation: [
      ...scripts.map((code, index) =>
        assistantMessage(
          [toolCall({ id: `script-${index}`, name: "codemode", arguments: { code } })],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Use IDE image reads as native Codemode image values");
}

function images(run: Awaited<ReturnType<typeof runScripts>>, id: string) {
  return getToolResultMessage(run, id).content.filter((block) => block.type === "image");
}

test("an IDE image read feeds image() and a classifier, and text reads stay composable", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await runScripts(cwd, "codemode-image-values", [
      String.raw`
const shown = await tools.read({path:"pixel.png"});
if (typeof shown === "string" || shown.type !== "image" || shown.mimeType !== "image/png" || typeof shown.note !== "string")
  throw Error("Expected an image block, got " + JSON.stringify(shown).slice(0, 200));
image(shown);
const model = await models.getModelOfType("classifier", "fixture-vision", "colour");
const answer = await models.classify(model, {state:{file:"pixel.png"}, images:[shown], questions:${colour}});
text(answer.stopReason === "stop" && answer.answers.colour.choice === "red" ? "branch:red" : "branch:other");
const failed = await models.classify(model, {state:{fail:true}, images:[shown], questions:${colour}});
text("failed:" + failed.stopReason + ":" + (failed.answers.colour === undefined));
const aborted = await models.classify(model, {state:{abort:true}, images:[shown], questions:${colour}});
text("aborted:" + aborted.stopReason + ":" + (aborted.answers.colour === undefined));
const note = await tools.read({path:"note.txt"});
if (typeof note !== "string") throw Error("Text Read must stay a string");
const found = await tools.search({path:note, query:"beta"});
text("composed:" + found.hasMatches);
const missing = await tools.read({path:"missing.png"});
text("missing:" + (missing?.status === "error" && missing.errors.length > 0 && missing.type === undefined));
`,
    ]);
    expect(getToolExecution(run, "script-0").isError, getToolResultText(run, "script-0")).toBe(
      false,
    );
    const output = getToolResultText(run, "script-0");
    for (const expected of [
      "branch:red",
      "failed:error:true",
      "aborted:aborted:true",
      "composed:true",
      "missing:true",
    ])
      expect(output).toContain(expected);
    expect(images(run, "script-0")).toEqual([
      { type: "image", data: pixel.toString("base64"), mimeType: "image/png" },
    ]);
    expect(output).not.toContain(pixel.toString("base64"));
    const saved = /\[Image saved to (\S+) \(image\/png/u.exec(output)?.[1];
    expect(saved).toBeDefined();
    expect(await readFile(saved as string)).toEqual(pixel);
    const calls = (await readFile(path.join(cwd, "classifier-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { images: unknown[] });
    expect(calls).toHaveLength(3);
    for (const call of calls)
      expect(call.images).toEqual([
        { type: "image", data: pixel.toString("base64"), mimeType: "image/png" },
      ]);
  });
});

test("nested images stay visible once without image() and several frames keep their order", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await runScripts(cwd, "codemode-image-visibility", [
      String.raw`
const shown = await tools.read({path:"pixel.png"});
text("read:" + shown.type);
`,
      String.raw`
const frames = await tools.read({path:"fixture-frames:"});
if (frames.type !== "images" || typeof frames.note !== "string") throw Error(JSON.stringify(frames).slice(0, 200));
frames.images.forEach((frame) => image(frame));
text("frames:" + frames.images.length);
`,
    ]);
    for (const id of ["script-0", "script-1"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(getToolResultText(run, "script-0")).toContain("read:image");
    expect(images(run, "script-0")).toEqual([
      { type: "image", data: pixel.toString("base64"), mimeType: "image/png" },
    ]);
    expect(getToolResultText(run, "script-1")).toContain("frames:2");
    expect(images(run, "script-1").map((block) => block.data)).toEqual(FIXTURE_FRAMES);
  });
});
