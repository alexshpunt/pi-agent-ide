import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";

import {
  assistantMessage,
  getToolResultMessage,
  getToolCallNames,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, beforeAll, expect, test } from "vitest";

import { generateReadExtensions } from "pi-agent-read/testing";

const generatedExtensions = await generateReadExtensions([
  "src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-image/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-pdf/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-html/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-text/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-web/index.ts",
]);
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const png = Buffer.from(pngBase64, "base64");
const pdf = Buffer.from(
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA3IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NiA+PgpzdHJlYW0KQlQKL0YxIDE4IFRmCjcyIDcyMCBUZAooSGVsbG8gZnJvbSBQREYpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDYxMiA3OTJdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDcgMCBSID4+ID4+IC9Db250ZW50cyA2IDAgUiA+PgplbmRvYmoKNiAwIG9iago8PCAvTGVuZ3RoIDQzID4+CnN0cmVhbQpCVAovRjEgMTggVGYKNzIgNzIwIFRkCihTZWNvbmQgcGFnZSkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago3IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ3IDAwMDAwIG4gCjAwMDAwMDAzNDIgMDAwMDAgbiAKMDAwMDAwMDQ2OCAwMDAwMCBuIAowMDAwMDAwNTYwIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgOCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNjMwCiUlRU9GCg==",
  "base64",
);
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const requestCounts = new Map<string, number>();
let server: Server;
let baseUrl: string;
const tempRoot = path.resolve(".agents/tmp/pi-agent-web");
let cwd: string;

beforeAll(async () => {
  await mkdir(tempRoot, { recursive: true });
  cwd = await mkdtemp(path.join(tempRoot, "workspace-"));
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
    if (pathname === "/browser-fallback") {
      if (request.headers["user-agent"]?.includes("Pi-LPT")) {
        response.writeHead(403);
        response.end("blocked");
      } else {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(
          '<html><body><main></main><script>document.querySelector("main").innerHTML = "<article><p>automatic-browser-fallback-marker with enough useful words for article extraction.</p></article>";</script></body></html>',
        );
      }
      return;
    }
    serve(pathname, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Local web fixture server has no TCP address");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await generatedExtensions.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  await rm(cwd, { recursive: true, force: true });
});

test("reads clean titled Markdown and resolves redirected relative links from the final URL", async () => {
  const articleResult = await runRead("/article", "web-html");
  const article = getToolResultText(articleResult);
  expect(article).toContain("# Web Article");
  expect(article).toContain("Useful article body");
  expect(article).toContain(`[Next](${baseUrl}/next)`);
  expect(article).not.toContain("Navigation noise");
  expect(article).not.toContain("window.unwanted");
  expect(article).not.toContain("## url:");

  expect(articleResult.tuiRenderedOutput).not.toContain("Failed to parse URL");

  const redirected = getToolResultText(await runRead("/redirect", "web-redirect"));
  expect(redirected).toContain("# Redirected Article");
  expect(redirected).toContain(`[Next](${baseUrl}/nested/next)`);
});

test("preserves text, JSON, empty text, and text ranges", async () => {
  expect(getToolResultText(await runRead("/text", "web-text"))).toBe("first\nsecond\nthird\n");
  expect(getToolResultText(await runRead("/json", "web-json"))).toBe('{"ok":true}\n');
  expect(getToolResultText(await runRead("/empty", "web-empty"))).toBe("");
  expect(getToolResultText(await runRead("/text", "web-text-range", { offset: 2, limit: 1 }))).toBe(
    "second\n\n[1 more lines in source. Use offset=3 to continue.]",
  );
});

test("reads PDF responses as page-oriented text", async () => {
  const content = getToolResultText(await runRead("/document.pdf", "web-pdf"));
  expect(content).toContain("# PDF document");
  expect(content).toContain("## Page 1 of 2\n\nHello from PDF");
  expect(content).toContain("## Page 2 of 2\n\nSecond page");
});

test("returns PNG and GIF as native image content", async () => {
  const pngResult = getToolResultMessage(await runRead("/misleading.data", "web-png"), "read");
  expect(pngResult).toMatchObject({
    isError: false,
    content: [
      { type: "text", text: "Read image [image/png]" },
      { type: "image", data: pngBase64, mimeType: "image/png" },
    ],
  });

  const gifResult = getToolResultMessage(await runRead("/pixel.gif", "web-gif"), "read");
  expect(gifResult.isError).toBe(false);
  expect(gifResult.content[1]).toMatchObject({ type: "image", mimeType: "image/gif" });

  const ranged = getToolResultMessage(
    await runRead("/misleading.data", "web-image-range", { offset: 1 }),
    "read",
  );
  expect(ranged).toMatchObject({
    details: { failure: { code: "UNSUPPORTED_RANGE", resolverId: "web" } },
  });
});

test.each([
  ["/malformed", "web-malformed"],
  ["/binary", "web-unsupported-binary"],
  ["/status", "web-http-status"],
] as const)("reports %s failures with the web resolver identity", async (pathname, testName) => {
  const result = getToolResultMessage(await runRead(pathname, testName), "read");
  expect(result).toMatchObject({
    details: { failure: { code: "READ_FAILED", resolverId: "web" } },
  });
});

test("recovers HTTP 403 through real Chromium within one read call", async () => {
  const run = await runRead("/browser-fallback", "web-browser-fallback");
  expect(getToolResultMessage(run, "read").isError).toBe(false);
  expect(getToolResultText(run)).toContain("automatic-browser-fallback-marker");
  expect(getToolCallNames(run)).toEqual(["read"]);
  expect(requestCounts.get("/browser-fallback")).toBe(2);
});

function runRead(
  pathname: string,
  testName: string,
  range: { readonly offset?: number; readonly limit?: number } = {},
) {
  return runSource(`${baseUrl}${pathname}`, testName, range);
}

function runSource(
  source: string,
  testName: string,
  range: { readonly offset?: number; readonly limit?: number } = {},
) {
  return new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName,
    cwd,
    extensions: generatedExtensions.paths,
    tools: ["read"],
    conversation: [
      assistantMessage(
        [toolCall({ id: "read", name: "read", arguments: { path: source, ...range } })],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("The web read finished")]),
    ],
  }).run(`Read ${source}`);
}

function serve(pathname: string, response: ServerResponse): void {
  switch (pathname) {
    case "/article": {
      html(response, "Web Article", "Useful article body", "/next");
      break;
    }
    case "/nested/article": {
      html(response, "Redirected Article", "Redirected body", "next");
      break;
    }
    case "/redirect": {
      response.writeHead(302, { Location: "/nested/article" });
      response.end();
      break;
    }
    case "/text": {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("first\nsecond\nthird\n");
      break;
    }
    case "/json": {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}\n');
      break;
    }
    case "/empty": {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end();
      break;
    }
    case "/misleading.data": {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(png);
      break;
    }
    case "/pixel.gif": {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(gif);
      break;
    }
    case "/document.pdf": {
      response.writeHead(200, { "Content-Type": "application/pdf" });
      response.end(pdf);
      break;
    }
    case "/malformed": {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(Buffer.from([0xc3, 0x28]));
      break;
    }
    case "/binary": {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(Buffer.from([0xc3, 0x28]));
      break;
    }
    case "/status": {
      response.writeHead(503, "Unavailable");
      response.end("unavailable");
      break;
    }
    case "/slow": {
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { "Content-Type": "text/plain" });
          response.end("late");
        }
      }, 250);
      break;
    }
    default: {
      response.writeHead(404);
      response.end("missing");
    }
  }
}

function html(response: ServerResponse, title: string, body: string, href: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><title>${title}</title><link rel="canonical" href="${href}"></head><body>
<nav>Navigation noise</nav><main><article><p>${body} with enough words for deterministic extraction.</p>
<a href="${href}">Next</a></article></main><script>window.unwanted = true;</script></body></html>`);
}
