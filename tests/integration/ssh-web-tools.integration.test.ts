import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { startSshWebFixture } from "./support/ssh-web-fixture.js";
import { createPdfFixture } from "#test-fixtures/pdf";
const restore = forceStandaloneIntegrationFile();
afterAll(restore);

// Protect the actual extension loader, ordinary tools, converter and native Codemode owner routing.
test("ordinary explicit target web reads and searches retain their owner while browser fallback renders native DOM", async () => {
  const requests: string[] = [];
  const media = createCanvas(4, 3);
  const paint = media.getContext("2d");
  paint.fillStyle = "#0000ff";
  paint.fillRect(0, 0, 4, 3);
  const mediaBytes = media.toBuffer("image/png");
  const pdfBytes = createPdfFixture(["Owned target PDF value 42"]);
  const proxy = createServer((request, response) => {
    requests.push(request.url ?? "");
    const route = new URL(request.url ?? "/", "http://lpt149-owned.invalid").pathname;
    if (route === "/media.png" || route === "/proof.pdf") {
      response.writeHead(200, {
        "content-type": route === "/media.png" ? "image/png" : "application/pdf",
      });
      response.end(route === "/media.png" ? mediaBytes : pdfBytes);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      route === "/red"
        ? '<html><body style="margin:0;background:#ff0000"></body></html>'
        : route === "/browser"
          ? '<!doctype html><html><body><script>document.body.innerHTML="<article><h1>Native café browser</h1><p>Rendered value 43</p></article>";</script></body></html>'
          : '<!doctype html><html><body><article><h1>Owned café HTTP</h1><p>Native value 42</p><a href="./detail">Detail</a></article></body></html>',
    );
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("No private proxy address");
  const fixture = await startSshWebFixture(`http://127.0.0.1:${address.port}`);
  const base = path.resolve(".tmp/ssh-web-tool-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const source = "web:ssh://fixture/http://lpt149-owned.invalid/static?value=42#section";
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
      }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({
        targets: [
          {
            id: "fixture",
            host: "fixture",
            workspace: fixture.workspace,
            configFile: fixture.config,
          },
        ],
      }),
    );
    const imageSource = "web:ssh://fixture/http://lpt149-owned.invalid/red";
    const run = await new PiIntegrationTest({
      testName: "ssh-web-tools",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "codemode"],
      timeoutMs: 40_000,
      conversation: [
        assistantMessage([
          toolCall({ id: "target-http", name: "read", arguments: { path: source } }),
        ]),
        assistantMessage([
          toolCall({
            id: "target-search",
            name: "search",
            arguments: { path: source, query: "café" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "target-regex",
            name: "search",
            arguments: { path: source, query: "regex:Native value \\d+" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "target-browser",
            name: "read",
            arguments: { path: "web:ssh://fixture/http://lpt149-owned.invalid/browser" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "ordinary-local",
            name: "read",
            arguments: { path: `http://127.0.0.1:${address.port}/static` },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "unknown-target",
            name: "read",
            arguments: { path: "web:ssh://missing/http://lpt149-owned.invalid/static" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "structured",
            name: "codemode",
            arguments: {
              code: `const r=await tools.read({path:${JSON.stringify(source)}}); text(r);`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "target-image",
            name: "read",
            arguments: {
              path: imageSource,
              views: ["image:scale=0.5,region=0.25,0.25,0.5,0.5"],
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "structured-images",
            name: "codemode",
            arguments: {
              code: `const r=await tools.read({path:${JSON.stringify(imageSource)},views:["sequence:duration=0.1,interval=0.1,scale=0.5"],limit:64,offset:1}); text(r);`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "target-media",
            name: "read",
            arguments: { path: "web:ssh://fixture/http://lpt149-owned.invalid/media.png" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "target-pdf",
            name: "read",
            arguments: { path: "web:ssh://fixture/http://lpt149-owned.invalid/proof.pdf" },
          }),
        ]),
        assistantMessage([text("Explicit target web routing verified.")]),
      ],
    }).run("Use only the explicit target for scoped URLs; keep plain URLs local.");
    for (const id of [
      "target-http",
      "target-search",
      "target-regex",
      "target-browser",
      "ordinary-local",
      "structured",
      "target-image",
      "structured-images",
      "target-media",
      "target-pdf",
    ])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(getToolResultText(run, "target-http")).toContain("Owned café HTTP");
    expect(getToolResultText(run, "target-http")).toContain("http://lpt149-owned.invalid/detail");
    expect(getToolResultText(run, "target-search")).toContain(source);
    expect(getToolResultText(run, "target-search")).toContain("café");
    expect(getToolResultText(run, "target-search")).not.toMatch(/SEARCH#[A-F\d]{4,}/u);
    expect(getToolResultText(run, "target-regex")).toContain("Native value 42");
    expect(getToolResultText(run, "target-browser")).toContain("Rendered value 43");
    expect(getToolResultText(run, "ordinary-local")).toContain("Owned café HTTP");
    expect(getToolExecution(run, "unknown-target").isError).toBe(true);
    expect(getToolResultText(run, "unknown-target")).toContain("UNKNOWN_TARGET");
    expect(getToolResultText(run, "structured")).toContain("Owned café HTTP");
    const frame = getToolResultMessage(run, "target-image").content.find((b) => b.type === "image");
    if (!frame) throw new Error("No target browser image");
    const image = await loadImage(Buffer.from(frame.data, "base64"));
    expect([image.width, image.height]).toEqual([320, 180]);
    const canvas = createCanvas(image.width, image.height);
    const drawing = canvas.getContext("2d");
    drawing.drawImage(image, 0, 0);
    expect(Array.from(drawing.getImageData(0, 0, 1, 1).data)).toEqual([255, 0, 0, 255]);
    expect(getToolExecutionDetails(getToolExecution(run, "target-image"))).toMatchObject({
      source: imageSource,
    });
    expect(
      getToolResultMessage(run, "structured-images").content.filter(
        (block) => block.type === "image",
      ),
    ).toHaveLength(2);
    expect(getToolResultText(run, "target-pdf")).toContain("Owned target PDF value 42");
    const mediaFrame = getToolResultMessage(run, "target-media").content.find(
      (b) => b.type === "image",
    );
    if (!mediaFrame) throw new Error("No target HTTP media image");
    const convertedImage = await loadImage(Buffer.from(mediaFrame.data, "base64"));
    expect([convertedImage.width, convertedImage.height]).toEqual([4, 3]);
    paint.drawImage(convertedImage, 0, 0);
    expect(Array.from(paint.getImageData(0, 0, 1, 1).data)).toEqual([0, 0, 255, 255]);
    expect(run.tuiRenderedOutput).toContain(source);
    expect(requests.some((url) => url.startsWith("http://lpt149-owned.invalid/"))).toBe(true);
    expect(requests).toContain("/static");
  } finally {
    try {
      await fixture.stop();
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(cwd, { recursive: true, force: true });
    }
  }
}, 50_000);
