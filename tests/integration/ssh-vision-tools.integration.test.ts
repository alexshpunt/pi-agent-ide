import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { loadImage } from "@napi-rs/canvas";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { startSshVisionFixture } from "./support/ssh-vision-fixture.js";
const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("ordinary target window reads retain canonical images, sequence bounds and display refusal", async () => {
  const fixture = await startSshVisionFixture();
  const base = path.resolve(".tmp/ssh-vision-tool-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const resource = `window:ssh://fixture/${fixture.pid}`;
  try {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: [
          "ide.ast",
          "ide.lsp",
          "ide.formatter",
          "ide.lint",
          "ide.changes",
          "ide.diagnostics",
          "ide.debugger",
        ],
        preferences: { "vision.allowedExecutables": "python3.12" },
      }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [fixture.target] }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-vision-tools",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "codemode"],
      timeoutMs: 30_000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "window",
            name: "read",
            arguments: { path: resource, views: ["image:scale=1"] },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "display-denied",
            name: "read",
            arguments: { path: "display:ssh://fixture/#0" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "structured",
            name: "codemode",
            arguments: {
              code: `const r=await tools.read({path:${JSON.stringify(resource)},views:["sequence:duration=0.1,interval=0.1,scale=0.5"],limit:8,offset:1}); text(r);`,
            },
          }),
        ]),
        assistantMessage([text("Target pixels verified.")]),
      ],
    }).run("Capture only the allowlisted fixture window.");
    expect(getToolExecution(run, "window").isError, getToolResultText(run, "window")).toBe(false);
    const images = getToolResultMessage(run, "window").content.filter(
      (block) => block.type === "image",
    );
    expect(images).toHaveLength(1);
    const first = images[0];
    if (!first) throw new Error("Missing target image");
    const image = await loadImage(Buffer.from(first.data, "base64"));
    expect([image.width, image.height]).toEqual([32, 24]);
    expect(getToolExecution(run, "display-denied").isError).toBe(true);
    expect(getToolResultText(run, "display-denied")).toContain("Display capture is disabled");
    expect(getToolExecution(run, "structured").isError, getToolResultText(run, "structured")).toBe(
      false,
    );
    expect(getToolResultText(run, "structured")).toContain(resource);
    expect(
      getToolResultMessage(run, "structured").content.filter((block) => block.type === "image"),
    ).toHaveLength(2);
    expect(run.tuiRenderedOutput).toContain(resource);
    const deniedSettings = {
      noAnimations: true,
      noPostProcessing: true,
      disabled: [
        "ide.ast",
        "ide.lsp",
        "ide.formatter",
        "ide.lint",
        "ide.changes",
        "ide.diagnostics",
        "ide.debugger",
      ],
      preferences: { "vision.allowedExecutables": "not-the-fixture-executable" },
    };
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify(deniedSettings),
    );
    const wrapper = path.join(cwd, "pi-displays");
    await copyFile(path.resolve("tests/integration/fixtures/vision-display-pi.sh"), wrapper);
    await chmod(wrapper, 0o755);
    const authorizedDisplay = await new PiIntegrationTest({
      testName: "ssh-vision-display-opt-in",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      piCommand: wrapper,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read"],
      conversation: [
        assistantMessage([
          toolCall({
            id: "external-denied",
            name: "read",
            arguments: { path: resource, views: ["image"] },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "display",
            name: "read",
            arguments: { path: "display:ssh://fixture/#0", views: ["image:scale=1"] },
          }),
        ]),
        assistantMessage([text("Explicit display opt-in verified.")]),
      ],
    }).run("Read only the authorized private fixture display.");
    expect(getToolExecution(authorizedDisplay, "external-denied").isError).toBe(true);
    expect(getToolResultText(authorizedDisplay, "external-denied")).toContain(
      "Window capture is denied",
    );
    expect(
      getToolExecution(authorizedDisplay, "display").isError,
      getToolResultText(authorizedDisplay, "display"),
    ).toBe(false);
    const displayBlock = getToolResultMessage(authorizedDisplay, "display").content.find(
      (block) => block.type === "image",
    );
    if (!displayBlock) throw new Error("Missing opted-in display");
    const displayImage = await loadImage(Buffer.from(displayBlock.data, "base64"));
    expect([displayImage.width, displayImage.height]).toEqual([96, 64]);
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 40_000);
