import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { FIXTURE_FRAMES } from "#integration/support/image-classifier-fixture.js";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function run(
  cwd: string,
  name: string,
  steps: { id: string; name: string; arguments: Record<string, JsonValue> }[],
) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await mkdir(path.join(cwd, ".pi-agent"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  await writeFile(path.join(cwd, "pixel.png"), pixel);
  await writeFile(path.join(cwd, "note.txt"), "alpha\n");
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    transport: "rpc",
    environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
    extensions: [
      path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
      path.resolve("src/pi-agent-ide.ts"),
      path.resolve("tests/integration/support/image-classifier-fixture.ts"),
      "builtin:codemode",
    ],
    tools: ["read", "write", "codemode"],
    conversation: [
      ...steps.map((step) =>
        assistantMessage([toolCall({ ...step, delayMs: 0 })], { stopReason: "toolUse" }),
      ),
      assistantMessage([text("Done", { delayMs: 0 })]),
    ],
  }).run("Save images a Read returned through Write.");
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

test("Write saves the exact images of a Read named by its UUID or RESULT# reference", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await run(cwd, "write-image-reference", [
      { id: "shot", name: "read", arguments: { path: "pixel.png" } },
      { id: "uuid", name: "write", arguments: { path: "saved.png", content: "$issued-uuid:shot" } },
      {
        id: "prefix",
        name: "write",
        arguments: { path: "out/prefixed.png", content: "RESULT#$issued-uuid:shot" },
      },
      { id: "frames", name: "read", arguments: { path: "fixture-frames:" } },
      { id: "folder", name: "write", arguments: { path: "run/", content: "$issued-uuid:frames" } },
      {
        id: "mismatch",
        name: "write",
        arguments: { path: "shot.jpg", content: "$issued-uuid:shot" },
      },
      { id: "text", name: "read", arguments: { path: "note.txt" } },
      {
        id: "no-images",
        name: "write",
        arguments: { path: "text.png", content: "$issued-uuid:text" },
      },
      { id: "plain", name: "write", arguments: { path: "plain.txt", content: "hello\n" } },
    ]);
    for (const id of ["uuid", "prefix", "folder", "plain"])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(await readFile(path.join(cwd, "saved.png"))).toEqual(pixel);
    expect(await readFile(path.join(cwd, "out/prefixed.png"))).toEqual(pixel);
    const frames = [path.join(cwd, "run/frame-01.png"), path.join(cwd, "run/frame-02.png")];
    for (const [index, frame] of frames.entries()) {
      expect(getToolResultText(result, "folder")).toContain(frame);
      expect((await readFile(frame)).toString("base64")).toBe(FIXTURE_FRAMES[index]);
    }
    expect(getToolExecution(result, "mismatch").isError).toBe(true);
    expect(getToolResultText(result, "mismatch")).toContain(".png");
    expect(await exists(path.join(cwd, "shot.jpg"))).toBe(false);
    expect(getToolExecution(result, "no-images").isError).toBe(true);
    expect(getToolResultText(result, "no-images")).toContain("no kept images");
    expect(await exists(path.join(cwd, "text.png"))).toBe(false);
    expect(await readFile(path.join(cwd, "plain.txt"), "utf8")).toBe("hello\n");
  });
});

test("Codemode Write saves a Read image value and numbers several frames", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await run(cwd, "write-image-codemode", [
      {
        id: "script",
        name: "codemode",
        arguments: {
          code: String.raw`
const shot = await tools.read({ path: "pixel.png" });
const one = await tools.write({ path: "shot.png", content: shot });
const frames = await tools.read({ path: "fixture-frames:" });
const many = await tools.write({ path: "clip.png", content: frames });
text("one:" + JSON.stringify(one));
text("many:" + JSON.stringify(many));
`,
        },
      },
    ]);
    expect(getToolExecution(result, "script").isError, getToolResultText(result, "script")).toBe(
      false,
    );
    const output = getToolResultText(result, "script");
    const shot = path.join(cwd, "shot.png");
    const clips = [path.join(cwd, "clip-01.png"), path.join(cwd, "clip-02.png")];
    expect(output).toContain(`one:${JSON.stringify({ ok: true, files: [shot] })}`);
    expect(output).toContain(`many:${JSON.stringify({ ok: true, files: clips })}`);
    expect(await readFile(shot)).toEqual(pixel);
    for (const [index, clip] of clips.entries())
      expect((await readFile(clip)).toString("base64")).toBe(FIXTURE_FRAMES[index]);
  });
});
