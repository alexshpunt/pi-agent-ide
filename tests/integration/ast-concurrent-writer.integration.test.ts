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

/** Structural searches of a large file a peer rewrites every 150 ms. */
const searchRounds = 10;
/**
 * Rounds of structural search and edit on a smaller file with a calmer peer, so an edit has
 * windows it can win. Registering the anchors of a search has no such retry and is checked in
 * every round.
 */
const editRounds = 8;

async function runStress(cwd: string, name: string, code: string) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  // No language server is needed: this case is about structural search and its anchors.
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
    tools: ["ast_search", "replace", "bash", "delete", "codemode"],
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
  }).run("Search structurally and edit the files while other sessions keep writing them.");
}

test("ast_search keeps its matches, captures and edits while another session writes the file", async () => {
  await withTempWorkspace(async (cwd) => {
    const searched = createConcurrentWriterSource();
    const edited = createConcurrentWriterSource({ lines: 400, markers: 20 });
    await writeFile(path.join(cwd, "search.cpp"), searched.content);
    await writeFile(path.join(cwd, "edit.cpp"), edited.content);
    const peers = {
      searched: await installConcurrentWriter(cwd, {
        file: "search.cpp",
        script: "peer-ast-search.mjs",
        intervalMs: 150,
        lifetimeMs: 90_000,
      }),
      edited: await installConcurrentWriter(cwd, {
        file: "edit.cpp",
        script: "peer-ast-edit.mjs",
        intervalMs: 600,
        lifetimeMs: 90_000,
      }),
    };
    // One call of the identifier per matched node, and the one definition of it.
    const calls = 5;
    const definition = `int $NAME(int value) { return value + $ADD; }`;

    const run = await runStress(
      cwd,
      "ast-search-concurrent-writer",
      `// @options: {"timeout_ms": 150000}
for (const peer of ${JSON.stringify([peers.searched, peers.edited].map((peer) => ({ command: peer.command, session: peer.session })))})
  await tools.bash({command:peer.command,background:true,name:peer.session});
let searches = 0;
// Every match of an AST result must carry its id, and every capture node its own id. A result
// with a match or node without one is not a match list: ast_search then returns readable text.
const selected = (item) => typeof item.id === "string" && item.id.startsWith("RESULT#");
async function found(file, pattern, round, what, expected, captures) {
  const result = await tools.ast_search({path:file,pattern});
  searches += 1;
  const shown = JSON.stringify(result).slice(0, 2000);
  check(result !== null && typeof result === "object", "Round " + round + ": the " + what + " result of " + file + " is no match list: " + shown);
  const anchored = result.matches.filter(selected);
  check(anchored.length === expected,
    "Round " + round + ": the " + what + " result of " + file + " has " + anchored.length + " matches with ids instead of " + expected + ": " + shown);
  for (const name of captures ?? []) {
    const groups = result.matches.filter((match) => (match.captures[name] ?? []).length > 0 && match.captures[name].every(selected));
    check(groups.length === expected,
      "Round " + round + ": the " + what + " result has " + groups.length + " " + name + " captures instead of " + expected + ": " + shown);
  }
  return result;
}
// A large file a peer rewrites while every structural search of it runs.
for (let round = 1; round <= ${String(searchRounds)}; round += 1) {
  await found("search.cpp", ${JSON.stringify(`${searched.token}($ARG)`)}, round, "call", ${String(calls)}, ["ARG"]);
  await found("search.cpp", ${JSON.stringify(definition)}, round, "definition", 1, ["NAME","ADD"]);
}
// Edits from those results, on a file whose peer leaves windows an edit can win.
for (let round = 1; round <= ${String(editRounds)}; round += 1) {
  // The whole result as an edit source: the matched definition is rewritten.
  const whole = await found("edit.cpp", ${JSON.stringify(definition)}, round, "definition", 1, ["NAME","ADD"]);
  const rewritten = await tools.replace({path:whole,text:"int ${edited.token}(int value) { return value + " + String(round) + "; }"});
  check(typeof rewritten === "string", "Round " + round + ": whole-result rewrite returned " + JSON.stringify(rewritten));
  // A capture of a result with several matches: the argument of the first call is replaced.
  const uses = await found("edit.cpp", ${JSON.stringify(`${edited.token}($ARG)`)}, round, "call", ${String(calls)}, ["ARG"]);
  const argument = uses.matches[0].captures.ARG[0].id;
  const replaced = await tools.replace({path:argument,text:String(1000 + round)});
  check(typeof replaced === "string", "Round " + round + ": capture replace returned " + JSON.stringify(replaced));
  // Wait up to 5 s for a new peer write before the next round, even when the edits run quickly.
  // A stopped peer then fails the write-count check below instead of hanging the script.
  await tools.bash({command:'n=$(cat peer-ast-edit.mjs.writes 2>/dev/null || echo 0); for i in $(seq 100); do [ "$(cat peer-ast-edit.mjs.writes 2>/dev/null || echo 0)" -gt "$n" ] && break; sleep 0.05; done'});
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
    // The edits landed. The peer rewrites what it last read, so it can drop the newest edit;
    // the rounds themselves must not lose a match, a capture or an anchor.
    expect(content).toMatch(/int alpha_token_0\(int value\) \{ return value \+ \d+; \}/u);
    expect(content).toMatch(/alpha_token_0\(10\d\d\)/u);
  });
}, 150_000);
