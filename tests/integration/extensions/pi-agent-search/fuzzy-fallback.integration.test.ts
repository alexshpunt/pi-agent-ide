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
  expect(getToolResultText(result, "quoted")).toBe("No matches found.");
  expect(getToolResultText(result, "web")).toContain("No matches in " + fixture.url);
  expect(getToolResultText(result, "web")).not.toContain("SEARCH#");
  expect(fixture.requests()).toBe(1);
  expect(result.tuiRenderedOutput).toContain("Possible name: hintStrings");
  expect(result.tuiRenderedOutput).toContain("0 exact · 7 fuzzy matches · 1 file");
  expect(result.tuiRenderedOutput).toContain("No exact matches found");
  expect(result.tuiRenderedOutput).toContain("const hintStrings = this.hintStrings");
  expect(getToolResultText(result, "local")).not.toContain("const hintStrings =");
  expect(result.tuiRenderedOutput).toContain("Possible name: generateHintString");
  expect(result.tuiRenderedOutput).toContain("No matches");
}, 150_000);

test("composed Search returns separate typed groups whose Read reference refreshes only the exact alternative", async () => {
  const fixture = await setup();
  const code = `
const results = await Promise.all([tools.search({query:"generateHintStrings",path:"link_hints.js"}), tools.search({query:"generateHintStrings",path:${JSON.stringify(fixture.url)}})]);
for (const found of results) {
  if (found.status !== "success" || found.data.kind !== "matches" || found.data.matches.length !== 0) throw new Error("Original zero was lost");
  if ("fuzzyPresentation" in found.data || JSON.stringify(found.data).includes("const hintStrings =")) throw new Error("User preview leaked into agent projection");
  if (JSON.stringify(found.data.fuzzy.candidates.map(c => [c.identifier,c.matchCount])) !== JSON.stringify([["hintStrings",5],["generateHintString",2]])) throw new Error("Candidate groups were lost: " + JSON.stringify(found));
}
const local = results[0].data.fuzzy.candidates[0];
const web = results[1].data.fuzzy.candidates[0];
if (web.selection.all !== undefined || web.selection.matches.some(m => m.references !== undefined)) throw new Error("URL got editable SEARCH refs");
const before = await tools.read({path:local.selection.all.line});
if (before.status !== "success" || !JSON.stringify(before.data).includes("hintStrings")) throw new Error("Candidate Read failed");
text({originalMatches:0,localCandidates:results[0].data.fuzzy.candidates,webCandidates:results[1].data.fuzzy.candidates});
const changed = await tools.write({path:"link_hints.js",content:"hintStrings();\\nHintStrings();\\nmyhintStrings();\\ngenerateHintStrings();\\n"});
if (changed.status !== "success") throw new Error("Fixture edit failed");
await tools.flush({});
const after = await tools.read({path:local.selection.all.line});
if (after.status !== "success" || !JSON.stringify(after.data).includes("hintStrings();") || JSON.stringify(after.data).includes("HintStrings();") || JSON.stringify(after.data).includes("generateHintStrings();")) throw new Error("Read reranked fuzzy or changed exact semantics: " + JSON.stringify(after));
const stale = await tools.read({path:local.selection.matches[0].references.line});
if (stale.status !== "error") throw new Error("Individual candidate reference failed to go stale");
text("Exact candidate Read and refresh passed");
`;
  const result = await new PiIntegrationTest({
    testName: "fuzzy-vimium-composed",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: fixture.cwd,
    extensions: [ide, "builtin:codemode"],
    tools: ["search", "read", "write", "flush", "codemode"],
    rawMode: false,
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
