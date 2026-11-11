import { mkdir, writeFile } from "node:fs/promises";
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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { textResultChecks } from "#integration/support/text-result-checks.ts";

/** Calls of the searched function, each on its own line. */
const CALLS = 40;

/** A C++ file of about 3,000 lines with one function called {@link CALLS} times. */
function sourceFile(): string {
  const lines = ["// header", "int handle(int value) { return value + 1; }"];
  for (let index = 0; index < CALLS; index += 1) {
    lines.push(`int caller_${String(index)}() { return handle(${String(index)}); }`);
    for (let filler = 0; filler < 70; filler += 1)
      lines.push(
        `int filler_${String(index)}_${String(filler)}() { return ${String(filler)} * 3; }`,
      );
  }
  lines.push("int main() { return caller_0(); }", "");
  return lines.join("\n");
}

/**
 * Every round lists the references of one function while another session keeps writing the file,
 * with a path scope and with a Search result as the scope, and finally renames the whole list.
 * The writer runs inside the Pi workspace, like another agent editing the same file: it prepends
 * a line every 300 ms through a temp file and a rename, so existing lines keep their text and
 * only their numbers move.
 */
const script = String.raw`
const expected = ${String(CALLS)} + 1;
// clangd answers symbol searches from an index it fills after parsing the opened file.
let warm = "";
for (let attempt = 1; attempt <= 15; attempt += 1) {
  warm = String((await tools.lsp_search({ query: "handle", path: "main.cpp", references: true })).result);
  if (matches(warm).length === expected) break;
  await tools.bash({ command: "sleep 2" });
}
check(matches(warm).length === expected, "Without a writer the list is already short: " + warm.slice(0, 600));
await tools.bash({
  name: "peer-writer",
  background: true,
  command: "i=0; while [ ! -f stop ]; do i=$((i+1)); { printf '// peer %s\\n' \"$i\"; cat main.cpp; } > peer.tmp && mv peer.tmp main.cpp; sleep 0.3; done",
});
const report = [];
const failures = [];
const note = (label, result) => {
  const found = matches(String(result.result)).length;
  report.push(label + " hits=" + found + " complete=" + result.complete);
  if (found !== expected)
    failures.push(label + " listed " + found + " of " + expected + " (complete=" + result.complete + ")");
  return result;
};
let listed;
let scoped = 0;
try {
  for (let round = 1; round <= 3; round += 1) {
    note("round " + round + " path scope", await tools.lsp_search({ query: "handle", path: "main.cpp", references: true }));
    // A search under a writer sometimes returns a result without anchors; that is LPT-1382, so
    // this round asks again instead of failing, and the run needs one scoped call to count.
    let scope;
    for (let attempt = 1; attempt <= 3 && scope === undefined; attempt += 1)
      scope = matchRows(String((await tools.search({ path: "main.cpp", query: "int handle(int value)" })).result))[0];
    if (scope === undefined) { report.push("round " + round + " result scope: the search result has no anchor (LPT-1382)"); continue; }
    scoped += 1;
    note("round " + round + " result scope", await tools.lsp_search({ query: "handle", path: scope.ref, references: true }));
  }
  // An agent renames from the list it got under the writer: every call must move with it.
  listed = note("rename list", await tools.lsp_search({ query: "handle", path: "main.cpp", references: true }));
} finally {
  // The writer replaces the whole file, so a rename applied while it runs can be lost with the
  // copy it already made. The list is from the writer's text; the rename follows it afterwards.
  await tools.bash({ command: "touch stop" });
}
for (let attempt = 1; attempt <= 20; attempt += 1) {
  if (!String(await tools.read({ path: "shell:peer-writer" })).includes("status: running")) break;
  await tools.bash({ command: "sleep 0.3" });
}
const writes = String(await tools.bash({ command: "grep -c '// peer' main.cpp" })).match(/^\d+$/mu);
check(writes && Number(writes[0]) > 10, "The concurrent writer did not run: " + report.join("\n"));
report.push("writes=" + writes[0]);
check(failures.length === 0, failures.join("\n") + "\n" + report.join("\n"));
check(scoped > 0, "No round could use a result scope: " + report.join("\n"));
const all = /SEARCH#[A-F\d]+:all:match/.exec(String(listed.result));
check(all, "The reference list has no all-match anchor: " + String(listed.result).slice(0, 400));
await tools.replace({ path: all[0], text: "dispatch" });
const counted = String(await tools.bash({ command: "grep -c dispatch main.cpp; grep -c handle main.cpp || true" }));
const counts = (counted.match(/^\d+$/gm) ?? []).map(Number);
report.push("renamed=" + counts[0] + " left=" + counts[1]);
check(counts[0] === expected && counts[1] === 0, "The rename left calls behind: " + report.join("\n"));
text(report.join("\n"));`;

test("lsp_search lists every reference of a function while another session writes the file", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(path.join(cwd, "main.cpp"), sourceFile());
    const run = await new PiIntegrationTest({
      testName: "lsp-reference-writer",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      traceToolDetails: false,
      timeoutMs: 180_000,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "lsp_search", "replace", "bash", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "composed",
              name: "codemode",
              arguments: { code: textResultChecks + script },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done.")]),
      ],
    }).run("List the references of a function while another session writes the file");
    expect(getToolExecution(run, "composed").isError, getToolResultText(run, "composed")).toBe(
      false,
    );
  });
}, 300_000);
