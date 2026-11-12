import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { expect, test } from "vitest";

import {
  createConcurrentWriterSource,
  installConcurrentWriter,
} from "#integration/support/concurrent-writer.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { withTextResultChecks } from "#integration/support/text-result-checks.ts";

/** Searches of a large file a peer rewrites every 150 ms; each one must bring usable anchors. */
const searchRounds = 10;
/**
 * Rounds of search and edit on a smaller file with a calmer peer. An edit gives up after 8
 * attempts on newer text, so the peer must leave windows an edit of that file can win; the
 * registration of its search anchors has no such retry and is checked in every round.
 */
const editRounds = 8;

async function runStress(cwd: string, name: string, code: string) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  // No language server is needed: this case is about text search and its anchors.
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    rawMode: true,
    // The rounds run in one scripted call; the peers keep writing while they do.
    timeoutMs: 110_000,
    traceToolDetails: false,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "search", "replace", "bash", "delete", "codemode"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "stress",
            name: "codemode",
            arguments: { code: withTextResultChecks(code) },
            chunks: { kind: "fixed", size: 65_536 },
            delayMs: 0,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Rounds finished.", { delayMs: 0 })]),
    ],
  }).run("Search and edit the files while other sessions keep writing them.");
}

test("every search keeps usable anchors while another session writes the file", async () => {
  await withTempWorkspace(async (cwd) => {
    const searched = createConcurrentWriterSource();
    const edited = createConcurrentWriterSource({ lines: 400, markers: 20 });
    await writeFile(path.join(cwd, "search.cpp"), searched.content);
    await writeFile(path.join(cwd, "edit.cpp"), edited.content);
    const peers = {
      searched: await installConcurrentWriter(cwd, {
        file: "search.cpp",
        script: "peer-search.mjs",
        intervalMs: 150,
        lifetimeMs: 90_000,
      }),
      edited: await installConcurrentWriter(cwd, {
        file: "edit.cpp",
        script: "peer-edit.mjs",
        intervalMs: 600,
        lifetimeMs: 90_000,
      }),
    };

    const run = await runStress(
      cwd,
      "search-concurrent-writer",
      `// @options: {"timeout_ms": 150000}
for (const peer of ${JSON.stringify([peers.searched, peers.edited].map((peer) => ({ command: peer.command, session: peer.session })))})
  await tools.bash({command:peer.command,background:true,name:peer.session});
let searches = 0;
// Every match a result shows must carry its anchors; a result without them cannot be edited.
function anchored(result, round, what) {
  const rows = matchRows(result);
  const shown = (result.match(/^[^\\s]+:\\d+:\\d+-\\d+/gm) ?? []).length;
  check(shown > 0 && rows.length === shown,
    "Round " + round + ": the " + what + " result shows " + shown + " matches with " + rows.length + " match anchors: " + result);
  return rows;
}
async function found(file, query, round, what, expected) {
  const result = await tools.search({path:file,query}).then(value=>value.result);
  searches += 1;
  const rows = anchored(result, round, what);
  check(expected === undefined || rows.length === expected,
    "Round " + round + ": the " + what + " result of " + file + " shows " + rows.length + " matches instead of " + expected + ": " + result);
  return { result, rows };
}
// A large file a peer rewrites while every search of it runs.
for (let round = 1; round <= ${String(searchRounds)}; round += 1) {
  await found("search.cpp", "regex:alpha_token_\\\\d+", round, "identifier", ${String(searched.tokenOccurrences)});
  await found("search.cpp", ${JSON.stringify(searched.markerQuery)}, round, "marker", ${String(searched.markers)});
}
// Edits from those results, on a file whose peer leaves windows an edit can win.
for (let round = 1; round <= ${String(editRounds)}; round += 1) {
  // The whole result as an edit source: every occurrence of the identifier is renamed at once.
  const whole = await found("edit.cpp", "regex:alpha_token_\\\\d+", round, "identifier", ${String(edited.tokenOccurrences)});
  const renamed = await tools.replace({path:whole.result,text:"alpha_token_" + String(round)});
  check(typeof renamed === "string", "Round " + round + ": whole-result rename returned " + JSON.stringify(renamed));
  // Numbered anchors of a result with many matches: one marker of each round is retired.
  // The count is left open: the peer rewrites what it last read, so it can drop a retired marker.
  const markers = await found("edit.cpp", ${JSON.stringify(edited.markerQuery)}, round, "marker");
  const retired = await tools.replace({path:markers.rows[0].ref,text:"beta_done_" + String(round)});
  check(typeof retired === "string", "Round " + round + ": numbered rename returned " + JSON.stringify(retired));
}
for (const session of ${JSON.stringify([peers.searched.session, peers.edited.session])})
  await tools.delete({path:"shell:" + session});
text("searches " + searches);`,
    );

    expect(getToolExecution(run, "stress").isError, getToolResultText(run, "stress")).toBe(false);
    expect(getToolResultText(run, "stress")).toContain(
      `searches ${String(searchRounds * 2 + editRounds * 2)}`,
    );
    // Both peers really wrote their file throughout the rounds.
    expect(await peers.searched.writes()).toBeGreaterThan(searchRounds);
    expect(await peers.edited.writes()).toBeGreaterThan(editRounds);
    const content = await readFile(path.join(cwd, "edit.cpp"), "utf8");
    expect(content.split("\n").filter((line) => line.startsWith("// peer")).length).toBeGreaterThan(
      0,
    );
    // The edits landed. The peer rewrites what it last read, so it can drop the newest edit of
    // either side; the rounds themselves must not lose a match or an anchor.
    expect(content.match(/alpha_token_\d+/gu)).toHaveLength(edited.tokenOccurrences);
    expect(content.match(/beta_done_\d+/gu)?.length ?? 0).toBeGreaterThan(0);
    expect(content.match(/beta_\d{4}/gu)?.length ?? 0).toBeLessThan(edited.markers);
  });
}, 150_000);

/** Reads of a search's all-line reference from a file a peer rewrites every 50 ms. */
const readRounds = 20;

test("a Read of a search reference shows the matched lines while another session writes the file", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = createConcurrentWriterSource({ token: "alphaTokenValue" });
    await writeFile(path.join(cwd, "names.cpp"), source.content);
    const peer = await installConcurrentWriter(cwd, {
      file: "names.cpp",
      script: "peer-read.mjs",
      intervalMs: 50,
      lifetimeMs: 90_000,
    });

    const run = await runStress(
      cwd,
      "search-read-concurrent-writer",
      `// @options: {"timeout_ms": 150000}
await tools.bash({command:${JSON.stringify(peer.command)},background:true,name:${JSON.stringify(peer.session)}});
let rounds = 0;
// A failed round still stops the peer, so it cannot write into the next run's workspace.
try {
  for (let round = 1; round <= ${String(readRounds)}; round += 1) {
    const result = await tools.search({path:"names.cpp",query:"alphaTokenValue"}).then(value=>value.result);
    const all = /SEARCH#[A-F0-9]+:all:line/u.exec(result)?.[0];
    check(all !== undefined, "Round " + round + ": the search shows no all reference: " + result);
    // Each selected line is a line of the identifier; the peer only moves them down.
    const read = await tools.read({path:all});
    check(typeof read === "string", "Round " + round + ": the Read of " + all + " failed: " + JSON.stringify(read));
    const shown = body(read);
    check((shown.match(/alphaTokenValue/gu) ?? []).length === ${String(source.tokenOccurrences)} && !shown.includes("total += compute("),
      "Round " + round + ": the Read of " + all + " shows other lines: " + shown);
    rounds += 1;
  }
} finally {
  await tools.delete({path:"shell:" + ${JSON.stringify(peer.session)}});
}
text("read rounds " + rounds);`,
    );

    expect(getToolExecution(run, "stress").isError, getToolResultText(run, "stress")).toBe(false);
    expect(getToolResultText(run, "stress")).toContain(`read rounds ${String(readRounds)}`);
    expect(await peer.writes()).toBeGreaterThan(readRounds);
  });
}, 150_000);

/**
 * Searches that find nothing and offer possible names from a file a peer rewrites every 50 ms.
 * The window between finding a candidate and registering its anchors is short, so the rounds are
 * many and the peer fast: without captured text, a run of them loses a candidate's anchors.
 */
const candidateRounds = 40;

test("every possible-name candidate keeps its anchors while another session writes the file", async () => {
  await withTempWorkspace(async (cwd) => {
    // The query misspells the identifier, so the search finds nothing and offers it instead.
    const source = createConcurrentWriterSource({ token: "alphaTokenValue" });
    await writeFile(path.join(cwd, "names.cpp"), source.content);
    const peer = await installConcurrentWriter(cwd, {
      file: "names.cpp",
      script: "peer-names.mjs",
      intervalMs: 50,
      lifetimeMs: 90_000,
    });

    const run = await runStress(
      cwd,
      "search-candidate-concurrent-writer",
      `// @options: {"timeout_ms": 150000}
await tools.bash({command:${JSON.stringify(peer.command)},background:true,name:${JSON.stringify(peer.session)}});
let rounds = 0;
for (let round = 1; round <= ${String(candidateRounds)}; round += 1) {
  const result = await tools.search({path:"names.cpp",query:"alphaTokenValues"}).then(value=>value.result);
  check(result.includes("Possible name: alphaTokenValue ") && result.includes("${String(source.tokenOccurrences)} matches in 1 file"),
    "Round " + round + ": the search offers no complete candidate: " + result);
  // A candidate without anchors shows locations an edit cannot use.
  check(!result.includes("without stable references") && /Read: SEARCH#[A-F0-9]+:all:line/u.test(result),
    "Round " + round + ": the candidate lost its anchors: " + result);
  rounds += 1;
}
await tools.delete({path:"shell:" + ${JSON.stringify(peer.session)}});
text("candidate rounds " + rounds);`,
    );

    expect(getToolExecution(run, "stress").isError, getToolResultText(run, "stress")).toBe(false);
    expect(getToolResultText(run, "stress")).toContain(
      `candidate rounds ${String(candidateRounds)}`,
    );
    // The peer really wrote the file throughout the rounds.
    expect(await peer.writes()).toBeGreaterThan(candidateRounds);
  });
}, 150_000);
