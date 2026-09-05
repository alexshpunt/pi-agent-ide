import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { afterAll, beforeAll, expect, test } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { generateReadExtensions } from "pi-agent-read/testing";
import { expectToolRowsHaveBackground } from "#integration/support/tui-background.js";

const generatedExtensions = await generateReadExtensions([
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
  "src/plugins/pi-agent-ide-ast/index.ts",
  "src/plugins/pi-agent-ide-lsp/index.ts",
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-html/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-text/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-web/index.ts",
]);

const productionSource = path.resolve("src/code-view/reference.ts");
const tempRoot = path.resolve(".tmp/pi-agent-read-modes-demo");
const interactivePacing =
  process.env.PI_INTEGRATION_TEST_LIVE === "1"
    ? {}
    : { chunks: { kind: "fixed" as const, size: 256 }, delayMs: 0 };

let webServer: Server | undefined;
let webBaseUrl = "";

beforeAll(async () => {
  webBaseUrl = await startWebDemoServer();
});

afterAll(async () => {
  await Promise.all([
    closeServer(),
    generatedExtensions.dispose(),
    rm(tempRoot, { recursive: true, force: true }),
  ]);
});

test("shows every read rendering mode", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "reference.ts";
    await writeTypeScriptProject(directory, fileName, await readFile(productionSource, "utf8"));

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "interactive-demo-read-modes",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      rawMode: false,
      timeoutMs: 180_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "demo-read-source",
              name: "read",
              arguments: { path: fileName },
              ...interactivePacing,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "demo-read-ast",
              name: "read",
              arguments: { path: `ast:${fileName}` },
              ...interactivePacing,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "demo-read-web",
              name: "read",
              arguments: { path: `${webBaseUrl}/article` },
              ...interactivePacing,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("All read modes finished")]),
      ],
    }).run("Show source, AST, and markdown read modes on a production source file");

    const source = getToolResultText(result, "demo-read-source");
    const ast = getToolResultText(result, "demo-read-ast");
    const article = getToolResultText(result, "demo-read-web");

    expect(source).toContain("export type CodeViewScheme");
    expect(ast).toContain("export function parseCodeViewReference");
    expect(article).toContain("# Demo Article");
  });
});

test("shows included views once in the real read panel", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "view-read.ts";
    await writeFile(path.join(directory, fileName), "alpha\nbravo\n", "utf8");

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "interactive-demo-read-views",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      rawMode: false,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-views",
              name: "read",
              arguments: { path: fileName, views: ["lines", "anchors"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Read finished")]),
      ],
    }).run("Read a file with line and anchor views");

    const projected = getToolResultText(result, "read-views");
    const firstProjectedLine = projected.split("\n")[0] ?? "";
    const rendered = stripTerminalSequences(result.tuiRenderedOutput);
    const panel = rendered.slice(rendered.lastIndexOf("╭─"));

    expect(firstProjectedLine).toMatch(/^1#[A-F\d]+\|alpha$/u);
    expect(panel).toContain(firstProjectedLine);
  });
});

test("wraps a long source line in the real read panel", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "inherited-background.ts";
    const line = `const url = "${"alpha beta ".repeat(35)}https://example.com/${"x".repeat(120)}";`;
    await writeFile(path.join(directory, fileName), `${line}\n`, "utf8");

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "interactive-demo-read-word-wrap",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      rawMode: false,
      conversation: [
        assistantMessage(
          [toolCall({ id: "read-word-wrap", name: "read", arguments: { path: fileName } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Read finished")]),
      ],
    }).run("Read the long source file");

    const rendered = stripTerminalSequences(result.tuiRenderedOutput);
    const panel = rendered.slice(rendered.lastIndexOf("╭─"));
    const panelRows = panel.split("\n").filter((row) => row.includes("│"));

    expect(getToolExecution(result, "read-word-wrap").isError).toBe(false);
    expect(getToolResultText(result, "read-word-wrap")).toContain("https://example.com/");
    expect(panelRows.length).toBeGreaterThan(2);
    expect(panel).toContain("https://example.com/");
    expect(panel).toContain("xxx");

    expectToolRowsHaveBackground(result.terminalOutput, "https://example.com/");
  });
});

function startWebDemoServer(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

      if (pathname === "/article") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          "<!doctype html><html><head><title>Demo Article</title></head><body><h1>Demo Article</h1><p>Hello from demo</p></body></html>",
        );
      } else {
        response.writeHead(404);
        response.end("missing");
      }
    });

    webServer = server;

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Web demo server did not return a TCP endpoint"));
        return;
      }

      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function closeServer(): Promise<void> {
  const server = webServer;
  if (server === undefined) {
    return;
  }

  webServer = undefined;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function writeTypeScriptProject(
  directory: string,
  fileName: string,
  source: string,
): Promise<void> {
  const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
  await mkdir(configDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(configDirectory, "lsp-servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          "typescript-language-server": {
            command: [path.join(process.cwd(), "node_modules/.bin/tsc"), "--lsp", "--stdio"],
            rootMarkers: ["tsconfig.json"],
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: ["diagnostics"],
          },
        },
      }),
      "utf8",
    ),
    writeFile(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: [fileName] }),
      "utf8",
    ),
    writeFile(path.join(directory, fileName), source, "utf8"),
  ]);
}

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, "project-"));

  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
