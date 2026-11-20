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
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
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

/** Run each call as a direct tool call, in order, for checks of the readable result. */
async function runDirect(
  cwd: string,
  name: string,
  calls: readonly { id: string; name: string; arguments: Record<string, unknown> }[],
) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    rawMode: true,
    timeoutMs: 110_000,
    traceToolDetails: false,
    extensions: [path.resolve("src/pi-agent-ide.ts")],
    tools: ["search", "bash", "delete"],
    conversation: [
      ...calls.map((call) =>
        assistantMessage([toolCall({ ...call, delayMs: 0 })], { stopReason: "toolUse" }),
      ),
      assistantMessage([text("Rounds finished.", { delayMs: 0 })]),
    ],
  }).run("Search the file while another session keeps writing it.");
}

test("RESULT Read follows moved selections and rejects changed selected text", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "selected.txt"), "before\nneedle\nafter\n");
    const run = await runStress(
      cwd,
      "result-read-changed-selection",
      `
const result = await tools.search({path:"selected.txt",query:"needle"});
check(result.matches.length === 1, "expected one selection");
await tools.bash({command:"printf 'new\\nbefore\\nneedle\\nafter\\n' > selected.txt"});
const moved = await tools.read({path:result.id});
check(moved !== null && moved.text.includes("needle") && !moved.text.includes("before"), "wrong moved selection: " + JSON.stringify(moved));
await tools.bash({command:"printf 'new\\nbefore\\nchanged\\nafter\\n' > selected.txt"});
await rejects(() => tools.read({path:result.id}));
text("moved then rejected");
`,
    );
    const output = getToolResultText(run, "stress");
    expect(getToolExecution(run, "stress").isError, output).toBe(false);
    expect(output).toContain("moved then rejected");
    expect(codemodeFailures(output)).toMatch(/stale|changed/iu);
  });
});
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
// Every match of a result must carry its id; a match without one cannot be edited. A result with
// such a match is not a match list: Search then returns its readable text instead.
function anchored(result, round, what) {
  check(result !== null && typeof result === "object" && result.matches.length > 0 &&
    result.matches.every((match) => typeof match.id === "string" && match.id.startsWith("RESULT#")),
    "Round " + round + ": the " + what + " result has matches without ids: " + JSON.stringify(result).slice(0, 2000));
  return result.matches;
}
async function found(file, query, round, what, expected) {
  const result = await tools.search({path:file,query});
  searches += 1;
  const matches = anchored(result, round, what);
  check(expected === undefined || matches.length === expected,
    "Round " + round + ": the " + what + " result of " + file + " has " + matches.length + " matches instead of " + expected + ": " + JSON.stringify(result).slice(0, 2000));
  return result;
}
try {
// A large file a peer rewrites while every search of it runs.
for (let round = 1; round <= ${String(searchRounds)}; round += 1) {
  await found("search.cpp", "regex:alpha_token_\\\\d+", round, "identifier", ${String(searched.tokenOccurrences)});
  await found("search.cpp", ${JSON.stringify(searched.markerQuery)}, round, "marker", ${String(searched.markers)});
}
// Edits from those results, on a file whose peer leaves windows an edit can win.
for (let round = 1; round <= ${String(editRounds)}; round += 1) {
  // The whole result as an edit source: every occurrence of the identifier is renamed at once.
  const whole = await found("edit.cpp", "regex:alpha_token_\\\\d+", round, "identifier", ${String(edited.tokenOccurrences)});
  const renamed = await tools.replace({path:whole,text:"alpha_token_" + String(round)});
  check(renamed === null || (typeof renamed === "string" && renamed.startsWith("RESULT#")), "Round " + round + ": invalid whole-result rename value: " + JSON.stringify(renamed));
  // Match ids of a result with many matches: one marker of each round is retired.
  // The count is left open: the peer rewrites what it last read, so it can drop a retired marker.
  const markers = await found("edit.cpp", ${JSON.stringify(edited.markerQuery)}, round, "marker");
  const retired = await tools.replace({path:markers.matches[0].id,text:"beta_done_" + String(round)});
  check(retired === null || (typeof retired === "string" && retired.startsWith("RESULT#")), "Round " + round + ": invalid numbered rename value: " + JSON.stringify(retired));
  // Give the slower peer a write window even when the edit rounds finish quickly.
  await tools.bash({command:"sleep 0.6"});
}
} finally {
  for (const session of ${JSON.stringify([peers.searched.session, peers.edited.session])})
    await tools.delete({path:"shell:" + session});
}
text("searches " + searches);`,
    );

    expect(getToolExecution(run, "stress").isError, getToolResultText(run, "stress")).toBe(false);
    expect(getToolResultText(run, "stress")).toContain(
      `searches ${String(searchRounds * 2 + editRounds * 2)}`,
    );
    // A failed IDE call also resolves to null; the failure ledger must stay empty.
    expect(codemodeFailures(getToolResultText(run, "stress"))).toBe("");
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

/** Reads of a search's whole selection from a file a peer rewrites every 50 ms. */
const readRounds = 20;

test("a Read of a search result shows its matches while another session writes the file", async () => {
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
    const result = await tools.search({path:"names.cpp",query:"alphaTokenValue"});
    check(result !== null && typeof result === "object" && result.complete && result.matches.length === ${String(source.tokenOccurrences)},
      "Round " + round + ": the search selected no complete match list: " + JSON.stringify(result).slice(0, 2000));
    const all = result.id;
    // Each selected range is an occurrence of the identifier; the peer only moves them down.
    const read = await tools.read({path:result.id});
    check(typeof read.text === "string", "Round " + round + ": the Read of " + all + " failed: " + JSON.stringify(read));
    const shown = read.text;
    check((shown.match(/alphaTokenValue/gu) ?? []).length === ${String(source.tokenOccurrences)} && !shown.includes("total += compute("),
      "Round " + round + ": the Read of " + all + " shows other lines: " + shown);
    rounds += 1;
  }
} finally {
  await tools.delete({path:"shell:" + ${JSON.stringify(peer.session)}});
}
text("read rounds " + rounds);`,
    );

    const output = getToolResultText(run, "stress");
    expect(getToolExecution(run, "stress").isError, output).toBe(false);
    expect(output).toContain(`read rounds ${String(readRounds)}`);
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

    // Possible names are readable text of a direct call; a Codemode value leaves them out.
    const rounds = Array.from(
      { length: candidateRounds },
      (_, index) => `round-${String(index + 1)}`,
    );
    const run = await runDirect(cwd, "search-candidate-concurrent-writer", [
      {
        id: "peer",
        name: "bash",
        arguments: { command: peer.command, background: true, name: peer.session },
      },
      ...rounds.map((id) => ({
        id,
        name: "search",
        arguments: { path: "names.cpp", query: "alphaTokenValues" },
      })),
      { id: "stop", name: "delete", arguments: { path: `shell:${peer.session}` } },
    ]);

    for (const id of ["peer", ...rounds, "stop"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    for (const id of rounds) {
      const result = getToolResultText(run, id);
      expect(result, `${id}: the search offers no complete candidate`).toContain(
        "Possible name: alphaTokenValue ",
      );
      expect(result, `${id}: the search offers no complete candidate`).toContain(
        `${String(source.tokenOccurrences)} matches in 1 file`,
      );
      // A candidate without anchors shows locations an edit cannot use.
      expect(result, `${id}: the candidate lost its anchors`).not.toContain(
        "without stable references",
      );
      expect(result, `${id}: the candidate lost its anchors`).toMatch(
        /Read: SEARCH#[A-F0-9]+:all:line/u,
      );
    }
    // The peer really wrote the file throughout the rounds.
    expect(await peer.writes()).toBeGreaterThan(candidateRounds);
  });
}, 150_000);
