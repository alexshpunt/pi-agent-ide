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

/** Rounds of search and edit; each round searches twice while the peer keeps writing. */
const rounds = 15;

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
    // The rounds run in one scripted call; the peer keeps writing while they do.
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
  }).run("Search and edit the file while another session keeps writing it.");
}

test("every search keeps usable anchors while another session writes the file", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = createConcurrentWriterSource();
    await writeFile(path.join(cwd, "main.cpp"), source.content);
    const peer = await installConcurrentWriter(cwd, {
      file: "main.cpp",
      intervalMs: 150,
      lifetimeMs: 90_000,
    });

    const run = await runStress(
      cwd,
      "search-concurrent-writer",
      `// @options: {"timeout_ms": 150000}
await tools.bash({command:${JSON.stringify(peer.command)},background:true,name:${JSON.stringify(peer.session)}});
const rounds = ${String(rounds)};
let searches = 0;
// Every match a result shows must carry its anchors; a result without them cannot be edited.
function anchored(result, round, what) {
  const rows = matchRows(result);
  const shown = (result.match(/^[^\\s]+:\\d+:\\d+-\\d+/gm) ?? []).length;
  check(shown > 0 && rows.length === shown,
    "Round " + round + ": the " + what + " result shows " + shown + " matches with " + rows.length + " match anchors: " + result);
  return rows;
}
for (let round = 1; round <= rounds; round += 1) {
  // The whole result as an edit source: every occurrence of the identifier is renamed at once.
  const whole = await tools.search({path:"main.cpp",query:"regex:alpha_token_\\\\d+"}).then(value=>value.result);
  searches += 1;
  check(anchored(whole, round, "identifier").length === ${String(source.tokenOccurrences)},
    "Round " + round + ": the identifier result lost matches: " + whole);
  const renamed = await tools.replace({path:whole,text:"alpha_token_" + String(round)});
  check(typeof renamed === "string", "Round " + round + ": whole-result rename returned " + JSON.stringify(renamed));
  // Numbered anchors of a result with many matches: one marker of each round is retired.
  const numbered = await tools.search({path:"main.cpp",query:${JSON.stringify(source.markerQuery)}}).then(value=>value.result);
  searches += 1;
  const rows = anchored(numbered, round, "marker");
  const retired = await tools.replace({path:rows[0].ref,text:"beta_done_" + String(round)});
  check(typeof retired === "string", "Round " + round + ": numbered rename returned " + JSON.stringify(retired));
}
await tools.delete({path:"shell:" + ${JSON.stringify(peer.session)}});
text("searches " + searches);`,
    );

    expect(getToolExecution(run, "stress").isError, getToolResultText(run, "stress")).toBe(false);
    expect(getToolResultText(run, "stress")).toContain(`searches ${String(rounds * 2)}`);
    // The peer really wrote the file throughout the rounds.
    const written = await peer.writes();
    expect(written).toBeGreaterThan(rounds);
    const content = await readFile(path.join(cwd, "main.cpp"), "utf8");
    const peerLines = content.split("\n").filter((line) => line.startsWith("// peer")).length;
    expect(peerLines).toBeGreaterThan(0);
    expect(peerLines).toBeLessThanOrEqual(written);
    // The edits landed. The peer rewrites what it last read, so it can drop the newest edit of
    // either side; the rounds themselves must not lose a match or an anchor.
    expect(content.match(/alpha_token_\d+/gu)).toHaveLength(source.tokenOccurrences);
    expect(content.match(/beta_done_\d+/gu)?.length ?? 0).toBeGreaterThan(0);
    expect(content.match(/beta_\d{4}/gu)?.length ?? 0).toBeLessThan(source.markers);
  });
}, 150_000);
