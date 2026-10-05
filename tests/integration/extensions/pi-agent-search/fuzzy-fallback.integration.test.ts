import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, onTestFinished, test } from "vitest";

const ide = path.resolve("src/pi-agent-ide.ts");
const fixturePath = path.resolve(
  "tests/integration/extensions/pi-agent-search/fixtures/fuzzy-vimium/link_hints.js",
);
async function setup() {
  const root = path.resolve(".tmp/fuzzy-fallback-integration");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = await readFile(fixturePath, "utf8");
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "0ddfcf3f3c6791dc3149ecda97ca28b413e4c5d8e430f429ffd5ea46c1cda3b1",
  );
  await copyFile(fixturePath, path.join(cwd, "link_hints.js"));
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(source);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected an HTTP fixture server");
  return {
    cwd,
    url: `http://127.0.0.1:${String(address.port)}/link_hints.js`,
    requests: () => requests,
  };
}
function call(id: string, name: string, arguments_: Record<string, unknown>) {
  return assistantMessage([toolCall({ id, name, arguments: arguments_ })], {
    stopReason: "toolUse",
  });
}

test("shows pinned Vimium possible names in native Search for files and URLs without hiding the zero", async () => {
  const fixture = await setup();
  const result = await new PiIntegrationTest({
    testName: "fuzzy-vimium-native",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: fixture.cwd,
    extensions: [ide],
    tools: ["search"],
    rawMode: false,
    timeoutMs: 120_000,
    conversation: [
      call("local", "search", { query: "generateHintStrings", path: "link_hints.js" }),
      call("quoted", "search", { query: '"generateHintStrings"', path: "link_hints.js" }),
      call("web", "search", { query: "generateHintStrings", path: fixture.url }),
      assistantMessage([text("Done")]),
    ],
  }).run(
    "Find a possibly misremembered Vimium identifier in a local file and the same served source",
  );
  for (const id of ["local", "quoted", "web"])
    expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
  for (const id of ["local", "web"]) {
    const shown = getToolResultText(result, id);
    expect(shown).toContain("Possible name: hintStrings");
    expect(shown).toContain("5 matches in 1 file");
    expect(shown).toContain("Possible name: generateHintString");
    expect(shown).toContain("2 matches in 1 file");
    expect(shown).toContain("spelling suggestions, not equivalent behavior");
  }
  expect(getToolExecutionDetails(getToolExecution(result, "local"))).toMatchObject({
    payload: {
      matchCount: 0,
      fuzzy: {
        candidates: [
          { identifier: "hintStrings", matchCount: 5 },
          { identifier: "generateHintString", matchCount: 2 },
        ],
      },
    },
  });
  expect(getToolResultText(result, "quoted")).toMatch(/\nNo matches found\.$/u);
  expect(getToolResultText(result, "web")).toContain("No matches in " + fixture.url);
  expect(getToolResultText(result, "web")).not.toContain("SEARCH#");
  expect(fixture.requests()).toBe(1);
  const header = "0 exact · 7 fuzzy matches · 1 file";
  expect(result.tuiRenderedOutput).toContain(header);
  const localStart = result.tuiRenderedOutput.indexOf(header);
  const nextSearch = result.tuiRenderedOutput.indexOf('search "', localStart);
  const localCard = result.tuiRenderedOutput.slice(
    localStart,
    nextSearch === -1 ? undefined : nextSearch,
  );
  expect(localCard).toContain("hintStrings");
  expect(localCard).toContain("generateHintString");
  expect(localCard).toContain("Shown 3 of 5");
  expect(localCard).toContain("const hintStrings = this.hintStrings");
  for (const agentDetail of [
    "No exact matches found",
    "Possible name:",
    "not equivalent behavior",
    "remove leading component",
    "one character edit",
    "Read for all",
  ])
    expect(localCard).not.toContain(agentDetail);
  expect(getToolResultText(result, "local")).not.toContain("const hintStrings =");
  expect(result.tuiRenderedOutput).toContain("No matches");
}, 150_000);

test("composed Search shows separate alternatives whose Read reference refreshes only the exact alternative", async () => {
  const fixture = await setup();
  const code = String.raw`
const results = await Promise.all([tools.search({query:"generateHintStrings",path:"link_hints.js"}), tools.search({query:"generateHintStrings",path:${JSON.stringify(fixture.url)}})]);
for (const found of results) {
  if (typeof found !== "string" || !found.includes("No matches")) throw Error("Original zero was lost");
  if (found.includes("const hintStrings =")) throw Error("User preview leaked");
  const groups=found.split("Possible name: ").slice(1);
  if(groups.length!==2 || !groups[0].startsWith("hintStrings ") || !groups[0].includes("5 matches") || !groups[1].startsWith("generateHintString ") || !groups[1].includes("2 matches")) throw Error("Candidate groups were lost: "+found);
}
const local = results[0].split("Possible name: ")[1];
const web = results[1].split("Possible name: ")[1];
if (web.includes("SEARCH#")) throw Error("URL got editable SEARCH refs");
const reference=/Read: (SEARCH#[A-F\d]+:all:line)/.exec(local)?.[1];
if(!reference) throw Error("Candidate Read reference missing");
const before = await tools.read({path:reference});
if (!before.includes("hintStrings")) throw Error("Candidate Read failed");
const first=await tools.search({path:before,query:"hintStrings"});
const individual=/SEARCH#[A-F\d]+:\d+:match/.exec(first)?.[0];
if(!individual) throw Error("Candidate individual reference missing");
text(results[0]); text(results[1]);
await tools.write({path:"link_hints.js",content:"hintStrings();\nHintStrings();\nmyhintStrings();\ngenerateHintStrings();\n"});
await tools.flush({});
const after = await tools.read({path:reference});
if (!after.includes("hintStrings();") || after.includes("HintStrings();") || after.includes("generateHintStrings();")) throw Error("Read reranked fuzzy or changed exact semantics: "+after);
let stale=false; try { await tools.read({path:individual}); } catch { stale=true; }
if(!stale) throw Error("Individual candidate reference failed to go stale");
text("Exact candidate Read and refresh passed");
`;
  const result = await new PiIntegrationTest({
    testName: "fuzzy-vimium-composed",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: fixture.cwd,
    extensions: [ide, "builtin:codemode"],
    tools: ["search", "read", "write", "flush", "codemode"],
    rawMode: true,
    timeoutMs: 120_000,
    conversation: [call("script", "codemode", { code }), assistantMessage([text("Done")])],
  }).run(
    "Use fuzzy candidates through composed Search and current Read, then edit the fixture and refresh the candidate",
  );
  expect(getToolExecution(result, "script").isError, getToolResultText(result, "script")).toBe(
    false,
  );
  expect(getToolResultText(result, "script")).toContain("Exact candidate Read and refresh passed");
  expect(fixture.requests()).toBe(1);
}, 150_000);
