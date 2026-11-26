import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
  type PiIntegrationTestResult,
} from "pi-coding-agent-test";
import { afterEach, expect, test } from "vitest";
import type { FixtureRequest } from "./fixtures/serper-transport.ts";

type Call = { id: string; name: string; arguments: Record<string, unknown> };
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Runs scripted tool calls in a real Pi with Pi Agent IDE and the web search extension, with only HTTP replaced. */
async function run(
  calls: Call[],
  options: {
    mode?: string;
    setup?: (cwd: string) => Promise<void>;
    agent?: string;
    config?: Record<string, unknown>;
    reverse?: boolean;
  } = {},
): Promise<{ result: PiIntegrationTestResult; requests: FixtureRequest[]; cwd: string }> {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/serper-search-"));
  directories.push(cwd);
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  // Brave and Exa come first: the old chain would have asked them before Serper.
  await writeFile(
    path.join(cwd, ".pi", "websearch.json"),
    JSON.stringify({
      providers: [
        { provider: "brave", apiKey: "brave-key" },
        { provider: "exa", apiKey: "exa-key" },
        { provider: "serper", apiKey: "serper-key" },
      ],
      ...options.config,
    }),
  );
  await options.setup?.(cwd);
  const reportPath = path.join(cwd, "report.json");
  const ide = path.resolve(
    path.dirname(import.meta.dirname),
    "node_modules/pi-agent-ide/src/pi-agent-ide.ts",
  );
  const web = path.resolve(path.dirname(import.meta.dirname), "index.ts");
  const result = await new PiIntegrationTest({
    piCommand: path.resolve(
      path.dirname(import.meta.dirname),
      "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    ),
    testName: "serper-search",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [
      path.resolve(path.dirname(import.meta.dirname), "test/fixtures/serper-transport.ts"),
      ...(options.reverse ? [web, ide] : [ide, web]),
      "builtin:codemode",
    ],
    tools: ["web_search", "image_search", "read", "search", "codemode"],
    isolateUserResources: true,
    environment: {
      PI_SERPER_FIXTURE_REPORT: reportPath,
      ...(options.mode && { PI_SERPER_FIXTURE_MODE: options.mode }),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      ...(options.agent && { PI_CODING_AGENT_DIR: options.agent }),
    },
    conversation: [
      ...calls.map((call) => assistantMessage([toolCall(call)], { stopReason: "toolUse" })),
      assistantMessage([text("Done")]),
    ],
  }).run("Search");
  const requests = JSON.parse(
    await readFile(reportPath, "utf8").catch(() => "[]"),
  ) as FixtureRequest[];
  return { result, requests, cwd };
}
const serperCalls = (requests: FixtureRequest[]) =>
  requests.filter((request) => request.url.startsWith("https://google.serper.dev/"));
const endpointOf = (request: FixtureRequest) => new URL(request.url).pathname.slice(1);

test("web search asks only Serper, even when other providers are configured first", async () => {
  const { result, requests } = await run([
    { id: "web", name: "web_search", arguments: { query: "pi agents" } },
  ]);
  expect(requests.every((request) => request.url.startsWith("https://google.serper.dev/"))).toBe(
    true,
  );
  expect(requests.map((request) => request.body?.page)).toEqual([1, 2]);
  const output = getToolResultText(result, "web");
  expect(output).toContain("Result 10");
  expect(output).not.toContain("Result 11");
  expect(getToolExecutionDetails(getToolExecution(result, "web"))).toMatchObject({
    resource: "websearch:web",
  });
}, 60_000);

test("web search does not use native search even with a connected Codex subscription", async () => {
  const agent = await mkdtemp(path.resolve(".tmp/serper-agent-"));
  directories.push(agent);
  const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.x`;
  await writeFile(
    path.join(agent, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: token,
        refresh: "unused",
        expires: Date.now() + 3_600_000,
      },
    }),
  );
  await writeFile(
    path.join(agent, "models.json"),
    JSON.stringify({
      providers: { "openai-codex": { baseUrl: "http://127.0.0.1:1/backend-api" } },
    }),
  );
  const { result, requests } = await run(
    [{ id: "web", name: "web_search", arguments: { query: "pi agents" } }],
    { agent },
  );
  expect(getToolExecution(result, "web").isError).toBe(false);
  expect(requests.every((request) => request.url.startsWith("https://google.serper.dev/"))).toBe(
    true,
  );
  expect(
    getToolExecutionDetails(getToolExecution(result, "web")) as {
      answer?: string;
      native?: unknown;
    },
  ).not.toHaveProperty("native");
}, 60_000);

test("web search returns the Serper error instead of answering through another source", async () => {
  const { result, requests } = await run(
    [{ id: "web", name: "web_search", arguments: { query: "pi agents" } }],
    { mode: "no-credits" },
  );
  expect(getToolExecution(result, "web").isError).toBe(true);
  expect(getToolResultText(result, "web")).toContain("Not enough credits");
  expect(requests).toHaveLength(1);
}, 60_000);

test("Read pages through saved results and fetches only the pages it is missing", async () => {
  const { result, requests } = await run([
    { id: "web", name: "web_search", arguments: { query: "pi agents" } },
    { id: "saved", name: "read", arguments: { path: "websearch:web", offset: 11, limit: 5 } },
    { id: "fetched", name: "read", arguments: { path: "websearch:web", offset: 18, limit: 3 } },
    { id: "again", name: "read", arguments: { path: "websearch:web", offset: 1, limit: 2 } },
  ]);
  const saved = getToolResultText(result, "saved");
  expect(saved).toContain("Result 11");
  expect(saved).toContain("https://example.com/r/15");
  expect(saved).not.toContain("Result 16");
  const fetched = getToolResultText(result, "fetched");
  expect(fetched).toContain("Result 18");
  expect(fetched).toContain("Result 20");
  expect(getToolResultText(result, "again")).toContain("Result 1 ");
  expect(requests.map((request) => request.body?.page)).toEqual([1, 2, 3]);
}, 60_000);

test("Search finds text and URLs inside saved results", async () => {
  const { result } = await run([
    { id: "web", name: "web_search", arguments: { query: "pi agents" } },
    { id: "find", name: "search", arguments: { query: "r/12", path: "websearch:web" } },
  ]);
  expect(getToolExecution(result, "find").isError).toBe(false);
  expect(getToolResultText(result, "find")).toContain("Result 12");
}, 60_000);

test.each([false, true])(
  "Codemode reads saved web results with reverse load order %s",
  async (reverse) => {
    const { result } = await run(
      [
        { id: "web", name: "web_search", arguments: { query: "pi agents" } },
        {
          id: "script",
          name: "codemode",
          arguments: {
            code: `
const page = await tools.read({ path: "websearch:web", offset: 11, limit: 2 });
if (!page || typeof page.text !== "string" || !page.text.includes("Result 11") || page.text.includes("Result 13") || !page.id.startsWith("RESULT#")) throw Error("unexpected page: " + JSON.stringify(page));
const found = await tools.search({ path: "websearch:web", query: "r/12" });
if (typeof found !== "string" || !found.includes("Result 12")) throw Error("unexpected search: " + JSON.stringify(found));
const missing = await tools.read({ path: "websearch:no-such-session" });
if (missing !== null) throw Error("missing resource must return null");
text("typed web page OK");`,
          },
        },
      ],
      { reverse },
    );
    const output = getToolResultText(result, "script");
    expect(getToolExecution(result, "script").isError, output).toBe(false);
    expect(output).toContain("typed web page OK");
    expect(output).toContain("websearch:no-such-session");
  },
  60_000,
);

test("image search returns ten images from one call that fetched a hundred, and Read pages through them", async () => {
  const { result, requests } = await run([
    { id: "img", name: "image_search", arguments: { query: "eiffel tower" } },
    { id: "deep", name: "read", arguments: { path: "websearch:img", offset: 95, limit: 5 } },
    { id: "next", name: "read", arguments: { path: "websearch:img", offset: 101, limit: 2 } },
  ]);
  const output = getToolResultText(result, "img");
  expect(output).toContain("https://img.example/10.jpg");
  expect(output).toContain("https://thumb.example/10.jpg");
  expect(output).toContain("https://example.com/p/10");
  expect(output).toContain("640x480");
  expect(output).not.toContain("https://img.example/11.jpg");
  const deep = getToolResultText(result, "deep");
  expect(deep).toContain("https://img.example/99.jpg");
  expect(getToolResultText(result, "next")).toContain("https://img.example/101.jpg");
  expect(
    serperCalls(requests).map((request) => [
      endpointOf(request),
      request.body?.num,
      request.body?.page,
    ]),
  ).toEqual([
    ["images", 100, 1],
    ["images", 100, 2],
  ]);
}, 60_000);

test("image search by URL asks Serper Lens and lists the similar pages", async () => {
  const { result, requests } = await run([
    {
      id: "lens",
      name: "image_search",
      arguments: { image: "https://pics.example/cat.jpg", limit: 3 },
    },
  ]);
  expect(requests.map((request) => [endpointOf(request), request.body?.url])).toEqual([
    ["lens", "https://pics.example/cat.jpg"],
  ]);
  const output = getToolResultText(result, "lens");
  expect(output).toContain("https://example.com/similar/3");
  expect(output).not.toContain("https://example.com/similar/4");
}, 60_000);

test("image search by local file uploads it for one hour and sends the temporary URL to Lens", async () => {
  let size = 0;
  const { result, requests } = await run(
    [{ id: "lens", name: "image_search", arguments: { image: "photo.png" } }],
    {
      setup: async (cwd) => {
        const bytes = Buffer.from("not-really-a-png");
        size = bytes.length;
        await writeFile(path.join(cwd, "photo.png"), bytes);
      },
    },
  );
  expect(requests[0]).toMatchObject({
    upload: { name: "photo.png", size, fields: { reqtype: "fileupload", time: "1h" } },
  });
  expect(requests[1]).toMatchObject({
    url: "https://google.serper.dev/lens",
    body: { url: "https://litter.example/upload-1.png" },
  });
  expect(getToolResultText(result, "lens")).toContain("https://example.com/similar/1");
}, 60_000);

test("image search refuses a local file that is not an image before uploading anything", async () => {
  const { result, requests } = await run(
    [{ id: "lens", name: "image_search", arguments: { image: "notes.txt" } }],
    {
      setup: async (cwd) => {
        await writeFile(path.join(cwd, "notes.txt"), "secret");
      },
    },
  );
  expect(getToolExecution(result, "lens").isError).toBe(true);
  expect(requests).toEqual([]);
}, 60_000);

test("with a Catbox account the local file is uploaded to it and deleted as soon as Lens has answered", async () => {
  const { result, requests } = await run(
    [{ id: "lens", name: "image_search", arguments: { image: "photo.png" } }],
    {
      config: { catboxUserhash: "account-hash" },
      setup: async (cwd) => {
        await writeFile(path.join(cwd, "photo.png"), "not-really-a-png");
      },
    },
  );
  expect(requests.map((request) => request.url)).toEqual([
    "https://catbox.moe/user/api.php",
    "https://google.serper.dev/lens",
    "https://catbox.moe/user/api.php",
  ]);
  expect(requests[0]?.form).toMatchObject({ reqtype: "fileupload", userhash: "account-hash" });
  expect(requests[1]?.body).toMatchObject({ url: "https://files.catbox.moe/abc123.png" });
  expect(requests[2]?.form).toEqual({
    reqtype: "deletefiles",
    userhash: "account-hash",
    files: "abc123.png",
  });
  expect(getToolExecution(result, "lens").isError).toBe(false);
}, 60_000);

test("the Catbox copy is deleted even when Lens fails", async () => {
  const { result, requests } = await run(
    [{ id: "lens", name: "image_search", arguments: { image: "photo.png" } }],
    {
      mode: "no-credits",
      config: { catboxUserhash: "account-hash" },
      setup: async (cwd) => {
        await writeFile(path.join(cwd, "photo.png"), "not-really-a-png");
      },
    },
  );
  expect(getToolExecution(result, "lens").isError).toBe(true);
  expect(getToolResultText(result, "lens")).toContain("Not enough credits");
  expect(requests.at(-1)?.form).toMatchObject({ reqtype: "deletefiles", files: "abc123.png" });
}, 60_000);
