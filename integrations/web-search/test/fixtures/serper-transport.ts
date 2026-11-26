import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Replaces only HTTP for the extension under test. Serper answers with deterministic numbered results:
 * web page 1 returns 7 results and later pages 10, like the live service. Every request is recorded in the report file.
 * Any other host fails the request, which proves no other provider or native search is called.
 */
export interface FixtureRequest { url: string; body?: Record<string, unknown>; upload?: { name: string; size: number; fields: Record<string, string> }; form?: Record<string, string>; aborted?: boolean }

export default function serperTransport(pi: ExtensionAPI): void {
  const report: FixtureRequest[] = [];
  const reportPath = process.env.PI_SERPER_FIXTURE_REPORT;
  const outOfCredits = process.env.PI_SERPER_FIXTURE_MODE === "no-credits";
  // "hang" never answers; the fixture stops the agent as soon as the first request has started.
  const hang = process.env.PI_SERPER_FIXTURE_MODE === "hang";
  let abortAgent: (() => void) | undefined;
  const flush = (): void => { if (reportPath) writeFileSync(reportPath, JSON.stringify(report)); };
  const record = (request: FixtureRequest): void => { report.push(request); flush(); };

  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-web-search.runtime-transport")] = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("https://litterbox.catbox.moe/")) {
      const form = init?.body as FormData;
      const file = form.get("fileToUpload") as File;
      record({ url, upload: { name: file.name, size: file.size, fields: { reqtype: String(form.get("reqtype")), time: String(form.get("time")) } } });
      return new Response("https://litter.example/upload-1.png\n");
    }
    if (url === "https://catbox.moe/user/api.php") {
      const form = init?.body as FormData;
      const fields = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string")) as Record<string, string>;
      const file = form.get("fileToUpload") as File | null;
      record({ url, form: fields, ...(file && { upload: { name: file.name, size: file.size, fields } }) });
      return new Response(fields.reqtype === "deletefiles" ? "Files successfully deleted." : "https://files.catbox.moe/abc123.png");
    }
    if (!url.startsWith("https://google.serper.dev/")) { record({ url }); throw new Error(`Unexpected request ${url}`); }
    const body = JSON.parse(String(init?.body)) as Record<string, number | string>;
    const entry: FixtureRequest = { url, body };
    record(entry);
    if (hang) return new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { entry.aborted = true; flush(); reject(init.signal?.reason); }, { once: true });
      queueMicrotask(() => abortAgent?.());
    });
    if (outOfCredits) return Response.json({ message: "Not enough credits", statusCode: 400 }, { status: 400 });
    const endpoint = new URL(url).pathname.slice(1);
    const page = Number(body.page ?? 1);
    if (endpoint === "search") {
      const size = page === 1 ? 7 : 10;
      const first = page === 1 ? 1 : 7 + (page - 2) * 10 + 1;
      return Response.json({ organic: Array.from({ length: size }, (_, i) => ({ title: `Result ${first + i}`, link: `https://example.com/r/${first + i}`, snippet: `Snippet ${first + i}` })), credits: 1 });
    }
    if (endpoint === "images") {
      const first = (page - 1) * 100 + 1;
      return Response.json({ images: Array.from({ length: Number(body.num) }, (_, i) => ({ title: `Image ${first + i}`, imageUrl: `https://img.example/${first + i}.jpg`, imageWidth: 640, imageHeight: 480, thumbnailUrl: `https://thumb.example/${first + i}.jpg`, source: "Example", link: `https://example.com/p/${first + i}` })), credits: 2 });
    }
    if (endpoint === "lens") {
      return Response.json({ organic: Array.from({ length: 15 }, (_, i) => ({ title: `Similar ${i + 1}`, source: "Example", link: `https://example.com/similar/${i + 1}`, imageUrl: `https://img.example/similar-${i + 1}.jpg`, thumbnailUrl: `https://thumb.example/similar-${i + 1}.jpg` })), credits: 3 });
    }
    return new Response("not found", { status: 404 });
  };
  pi.on("tool_execution_start", (_event, ctx) => { abortAgent = () => ctx.abort(); });
  pi.on("session_start", () => {
    const surfacePath = process.env.PI_WEB_SEARCH_SURFACE_REPORT;
    if (!surfacePath) return;
    writeFileSync(surfacePath, JSON.stringify({
      tools: pi.getAllTools().map((tool) => ({ name: tool.name, description: tool.description, promptGuidelines: tool.promptGuidelines, sourceInfo: tool.sourceInfo })),
      commands: pi.getCommands().map((command) => ({ name: command.name, sourceInfo: command.sourceInfo })),
    }));
  });
  pi.on("session_shutdown", () => { delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-web-search.runtime-transport")]; });
}
