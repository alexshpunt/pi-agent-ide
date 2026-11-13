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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
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

test("composed Search keeps the original zero without suggestions, and a candidate Read reference refreshes only the exact alternative", async () => {
  const fixture = await setup();
  // Possible names stay out of Codemode values: scripts get the original zero as data.
  const code = String.raw`
const results = await Promise.all([tools.search({query:"generateHintStrings",path:"link_hints.js"}), tools.search({query:"generateHintStrings",path:${JSON.stringify(fixture.url)}})]);
// A file search selects its (empty) matches; a web page has no selections, so it has no id.
for (const [found, keys] of [[results[0], "complete,id,matches"], [results[1], "complete,matches"]]) {
  if (found === null || found.complete !== true || found.matches.length !== 0) throw Error("Original zero was lost: "+JSON.stringify(found));
  if (Object.keys(found).sort().join() !== keys) throw Error("Suggestions leaked into the value: "+JSON.stringify(found));
  if (JSON.stringify(found).includes("hintStrings")) throw Error("Suggestion or preview leaked: "+JSON.stringify(found));
}
text("Composed zero values passed");
`;
  // The candidate Read reference exists only in the readable result of a direct call. This
  // extension passes the actual references of the earlier calls to the later scripted calls.
  const references = path.join(fixture.cwd, "fuzzy-references.js");
  await writeFile(
    references,
    String.raw`export default function fuzzyReferences(pi) {
  const found = {};
  pi.on("tool_result", (event) => {
    const shown = JSON.stringify(event.content);
    if (event.toolCallId === "local") found["SEARCH#CANDIDATE"] = /Read: (SEARCH#[A-F\d]+:all:line)/.exec(shown)?.[1];
    if (event.toolCallId === "first") found["SEARCH#INDIVIDUAL"] = /SEARCH#[A-F\d]+:\d+:match/.exec(shown)?.[0];
  });
  pi.on("tool_call", (event) => {
    const input = event.input;
    if (typeof input.path !== "string" || !(input.path in found)) return;
    if (found[input.path] === undefined) throw new Error("Missing reference for " + input.path);
    input.path = found[input.path];
  });
}
`,
  );
  const changed = "hintStrings();\nHintStrings();\nmyhintStrings();\ngenerateHintStrings();\n";
  const result = await new PiIntegrationTest({
    testName: "fuzzy-vimium-composed",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: fixture.cwd,
    extensions: [ide, "builtin:codemode", references],
    tools: ["search", "read", "write", "codemode"],
    rawMode: true,
    timeoutMs: 120_000,
    conversation: [
      call("script", "codemode", { code }),
      call("local", "search", { query: "generateHintStrings", path: "link_hints.js" }),
      call("before", "read", { path: "SEARCH#CANDIDATE" }),
      call("first", "search", { path: "SEARCH#CANDIDATE", query: "hintStrings" }),
      call("write", "write", { path: "link_hints.js", content: changed }),
      call("after", "read", { path: "SEARCH#CANDIDATE" }),
      call("stale", "read", { path: "SEARCH#INDIVIDUAL" }),
      assistantMessage([text("Done")]),
    ],
  }).run(
    "Use fuzzy candidates through composed Search and current Read, then edit the fixture and refresh the candidate",
  );
  for (const id of ["script", "local", "before", "first", "write", "after"])
    expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
  expect(getToolResultText(result, "script")).toContain("Composed zero values passed");
  expect(getToolResultText(result, "local")).toContain("Possible name: hintStrings");
  expect(getToolResultText(result, "before")).toContain("hintStrings");
  expect(getToolResultText(result, "first")).toMatch(/SEARCH#[A-F\d]+:\d+:match/u);
  // Read keeps the exact alternative's semantics after the edit: no reranking, no fuzzy widening.
  const after = getToolResultText(result, "after");
  expect(after).toContain("hintStrings();");
  expect(after).not.toContain("HintStrings();");
  expect(after).not.toContain("generateHintStrings();");
  // The individual reference of the changed text goes stale.
  expect(getToolExecution(result, "stale").isError, getToolResultText(result, "stale")).toBe(true);
  expect(fixture.requests()).toBe(1);
}, 150_000);
