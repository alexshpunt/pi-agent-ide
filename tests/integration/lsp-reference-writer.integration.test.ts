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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { textResultChecks } from "#integration/support/text-result-checks.ts";

const CALLS = 40;

/** A large C++ file with one function called `CALLS` times and unrelated filler around them. */
function sourceFile(): string {
  const lines: string[] = ["// header", "int handle(int value) { return value + 1; }"];
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

test("lsp_search lists every reference while another session writes the file", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(path.join(cwd, "main.cpp"), sourceFile());
    const code =
      textResultChecks +
      String.raw`
const expected = ${String(CALLS)} + 1;
let warm = "";
for (let attempt = 1; attempt <= 15; attempt += 1) {
  const probe = await tools.lsp_search({ query: "handle", path: "main.cpp", references: true });
  warm = String(probe.result);
  if (matches(warm).length === expected) break;
  await tools.bash({ command: "sleep 2" });
}
check(matches(warm).length === expected, "Warm run: " + warm.slice(0, 600));
await tools.bash({ name: "peer-writer", background: true, command: "i=0; while [ ! -f stop ]; do i=$((i+1)); { printf '// peer %s\\n' \"$i\"; cat main.cpp; } > peer.tmp && mv peer.tmp main.cpp; sleep 0.3; done" });
const report = [];
const failures = [];
const note = (label, result, started) => {
  const found = matches(String(result.result)).length;
  report.push(label + " hits=" + found + " complete=" + result.complete + " ms=" + (Date.now() - started));
  if (found !== expected) failures.push(label + " listed " + found + " of " + expected + " (complete=" + result.complete + ")");
};
try {
  for (let round = 1; round <= 4; round += 1) {
    let started = Date.now();
    note("round " + round + " plain", await tools.lsp_search({ query: "handle", path: "main.cpp", references: true }), started);
    const found = await tools.search({ path: "main.cpp", query: "int handle(int value)" });
    const scope = matchRows(String(found.result))[0];
    if (scope === undefined) { report.push("round " + round + " scoped: no anchor"); continue; }
    started = Date.now();
    note("round " + round + " scoped", await tools.lsp_search({ query: "handle", path: scope.ref, references: true }), started);
  }
  // An agent renames from the list: every call must move to the new name at its current position.
  const started = Date.now();
  const list = await tools.lsp_search({ query: "handle", path: "main.cpp", references: true });
  note("rename list", list, started);
  const all = /SEARCH#[A-F\d]+:all:match/.exec(String(list.result));
  check(all, "The reference list has no all-match anchor: " + String(list.result).slice(0, 400));
  await tools.replace({ path: all[0], text: "dispatch" });
} finally {
  await tools.bash({ command: "touch stop" });
}
await tools.bash({ command: "sleep 1" });
const counted = String(await tools.bash({ command: "grep -c dispatch main.cpp; grep -c handle main.cpp || true" }));
const counts = counted.match(/^\d+$/gm) ?? [];
check(counts[0] === String(expected) && counts[1] === "0", "After the rename: " + counted.slice(0, 400));
check(failures.length === 0, failures.join("\n") + "\n" + report.join("\n"));
text(report.join("\n"));`;
    const run = await new PiIntegrationTest({
      testName: "lsp-reference-writer",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      traceToolDetails: false,
      timeoutMs: 240_000,
      ...(process.env.PI_LSP_DEBUG_REFS !== undefined && {
        environment: { PI_LSP_DEBUG_REFS: process.env.PI_LSP_DEBUG_REFS },
      }),
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "lsp_search", "replace", "bash", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "composed", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done.")]),
      ],
    }).run("List references while another session writes the file");
    const output = getToolResultText(run, "composed");
    await writeFile(path.resolve(".tmp/lsp-ref-report.txt"), output);
    const final = await readFile(path.join(cwd, "main.cpp"), "utf8");
    const peers = final.split("\n").filter((line) => line.startsWith("// peer")).length;
    expect(getToolExecution(run, "composed").isError, output).toBe(false);
    expect(peers, `${output}\npeers=${String(peers)}`).toBeGreaterThan(10);
  });
}, 300_000);
