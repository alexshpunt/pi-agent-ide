import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterAll, expect, test } from "vitest";
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
import { startIsolatedSshWebFixture } from "./support/ssh-isolated-web-fixture.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("ordinary web tools keep local URLs local and reach an SSH-only network endpoint", async () => {
  const fixture = await startIsolatedSshWebFixture();
  const base = path.resolve(".tmp/ssh-web-network-tools");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const source = `web:ssh://fixture/${fixture.url}/static?value=42#section`;
  const imageSource = `web:ssh://fixture/${fixture.url}/red`;
  try {
    await expect(
      fetch(fixture.url + "/static", { signal: AbortSignal.timeout(2000) }),
    ).rejects.toBeInstanceOf(Error);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [fixture.target] }),
    );
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
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-web-network-tools",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "codemode"],
      timeoutMs: 40_000,
      conversation: [
        assistantMessage([
          toolCall({ id: "local", name: "read", arguments: { path: fixture.url + "/static" } }),
        ]),
        assistantMessage([toolCall({ id: "http", name: "read", arguments: { path: source } })]),
        assistantMessage([
          toolCall({ id: "literal", name: "search", arguments: { path: source, query: "café" } }),
        ]),
        assistantMessage([
          toolCall({
            id: "regex",
            name: "search",
            arguments: { path: source, query: "regex:Native value [0-9]+" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "browser",
            name: "read",
            arguments: { path: `web:ssh://fixture/${fixture.url}/browser` },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "image",
            name: "read",
            arguments: { path: imageSource, views: ["image:scale=0.5,region=0.25,0.25,0.5,0.5"] },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "sequence",
            name: "codemode",
            arguments: {
              code: `const r=await tools.read({path:${JSON.stringify(imageSource)},views:["sequence:duration=0.1,interval=0.1,scale=0.5"],limit:64,offset:1});text(r);`,
            },
          }),
        ]),
        assistantMessage([text("SSH-only endpoint verification complete.")]),
      ],
    }).run(
      "Read the local URL first, then use only the explicit SSH owner for target web operations.",
    );
    expect(getToolExecution(run, "local").isError).toBe(true);
    expect(getToolResultText(run, "local")).not.toContain("Isolated café HTTP");
    for (const id of ["http", "literal", "regex", "browser", "image", "sequence"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(getToolResultText(run, "http")).toContain("Isolated café HTTP");
    expect(getToolResultText(run, "http")).toContain(fixture.url + "/detail");
    for (const id of ["literal", "regex"]) {
      expect(getToolResultText(run, id)).toContain(source);
      expect(getToolResultText(run, id)).not.toMatch(/SEARCH#[A-F\d]{4,}/u);
    }
    expect(getToolResultText(run, "regex")).toContain("Native value 42");
    expect(getToolResultText(run, "browser")).toContain("Native value 43");
    const frame = getToolResultMessage(run, "image").content.find((b) => b.type === "image");
    if (!frame) throw new Error("No isolated native browser image");
    const image = await loadImage(Buffer.from(frame.data, "base64"));
    expect([image.width, image.height]).toEqual([320, 180]);
    const paint = createCanvas(320, 180).getContext("2d");
    paint.drawImage(image, 0, 0);
    expect([...paint.getImageData(0, 0, 1, 1).data]).toEqual([255, 0, 0, 255]);
    expect(getToolResultText(run, "sequence")).toContain(imageSource);
    expect(
      getToolResultMessage(run, "sequence").content.filter((block) => block.type === "image"),
    ).toHaveLength(2);
    expect(run.tuiRenderedOutput).toContain(source);
    expect(run.tuiRenderedOutput).toContain("Isolated café HTTP");
    await expect(
      fetch(fixture.url + "/red", { signal: AbortSignal.timeout(2000) }),
    ).rejects.toBeInstanceOf(Error);
  } finally {
    try {
      await fixture.stop();
      for (const file of [
        fixture.root,
        `/proc/${fixture.supervisorPid}`,
        `/proc/${fixture.sshdPid}`,
      ])
        await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}, 50_000);
