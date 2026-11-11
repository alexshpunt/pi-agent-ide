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
import { installConcurrentWriter } from "#integration/support/concurrent-writer.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { withTextResultChecks } from "#integration/support/text-result-checks.ts";

/** Callers of the graphed function, each on its own line. */
const CALLERS = 40;
/** Graphs taken while the peer writes the file. */
const ROUNDS = 4;

/** A C++ file of about 3,000 lines with one function that {@link CALLERS} functions call. */
function sourceFile(): string {
  const lines = [
    "// header",
    "int helper(int value) { return value * 2; }",
    "int handle(int value) { return helper(value) + 1; }",
  ];
  for (let index = 0; index < CALLERS; index += 1) {
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
 * Takes the call graph of one function while another session keeps writing the file, and compares
 * every graph with the one taken before the writer started. The peer only inserts lines at the top,
 * so every reference and caller stays, and each line number in one graph moves by the same amount
 * as the definition's.
 */
const script = (peer: {
  command: string;
  session: string;
}) => String.raw`// @options: {"timeout_ms": 170000}
function graphOf(result) {
  const rows = String(result.result).split("\n");
  const definition = /^Definition: main\.cpp (\d+) /.exec(rows.find((row) => row.startsWith("Definition:")) ?? "");
  check(definition, "The graph has no definition line: " + String(result.result).slice(0, 600));
  const section = (title) => {
    const start = rows.findIndex((row) => row.startsWith(title));
    if (start === -1) return [];
    const end = rows.findIndex((row, index) => index > start && row === "");
    return rows.slice(start, end === -1 ? undefined : end);
  };
  const references = section("References:");
  const incoming = section("Incoming calls:");
  return {
    definition: Number(definition[1]),
    references: references[0],
    referenceLines: references.flatMap((row) => /^  - (\d+)$/.exec(row)?.slice(1).map(Number) ?? []),
    incoming: incoming[0],
    callers: incoming.flatMap((row) => {
      const hit = /^- \S+ (\S+) — main\.cpp (\d+)$/.exec(row);
      return hit ? [{ name: hit[1], line: Number(hit[2]) }] : [];
    }),
    outgoing: section("Outgoing calls:").join("\n"),
    raw: String(result.result).slice(0, 1500),
  };
}
const calls = async () => graphOf(await tools.lsp_search({ calls: "main.cpp#handle" }));
// clangd answers callers from an index it fills after parsing the opened file.
let baseline;
for (let attempt = 1; attempt <= 15; attempt += 1) {
  baseline = await calls();
  if (baseline.incoming === "Incoming calls: ${String(CALLERS)}") break;
  await tools.bash({ command: "sleep 2" });
}
check(baseline.incoming === "Incoming calls: ${String(CALLERS)}", "Without a writer the graph is already short: " + JSON.stringify(baseline));
check(baseline.references === "References: ${String(CALLERS + 1)} in 1 file(s)", "Without a writer the references are already short: " + JSON.stringify(baseline));
check(baseline.callers.length > 0 && baseline.referenceLines.length > 0, "The graph lists no lines: " + JSON.stringify(baseline));
const relative = (graph) => JSON.stringify({
  references: graph.references,
  referenceLines: graph.referenceLines.map((line) => line - graph.definition),
  incoming: graph.incoming,
  callers: graph.callers.map(({ name, line }) => [name, line - graph.definition]),
  outgoing: graph.outgoing,
});
const expected = relative(baseline);
await tools.bash({ command: ${JSON.stringify(peer.command)}, background: true, name: ${JSON.stringify(peer.session)} });
const report = ["baseline " + expected];
const failures = [];
try {
  for (let round = 1; round <= ${String(ROUNDS)}; round += 1) {
    let graph;
    try {
      graph = await calls();
    } catch (error) {
      failures.push("round " + round + " failed: " + String(error).slice(0, 300));
      continue;
    }
    const found = relative(graph);
    report.push("round " + round + " definition=" + graph.definition + " " + graph.references + " " + graph.incoming);
    if (found !== expected) failures.push("round " + round + " differs: " + found);
  }
} finally {
  await tools.delete({ path: ${JSON.stringify(`shell:${peer.session}`)} });
}
const writes = String(await tools.bash({ command: "grep -c '// peer' main.cpp" })).match(/^\d+$/mu);
check(writes && Number(writes[0]) > ${String(ROUNDS)}, "The concurrent writer did not run: " + report.join("\n"));
report.push("writes=" + writes[0]);
check(failures.length === 0, failures.join("\n") + "\n" + report.join("\n"));
text(report.join("\n"));`;

test("lsp_search calls lists every reference and caller while another session writes the file", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(path.join(cwd, "main.cpp"), sourceFile());
    const peer = await installConcurrentWriter(cwd, {
      file: "main.cpp",
      intervalMs: 150,
      lifetimeMs: 150_000,
    });
    const run = await new PiIntegrationTest({
      testName: "lsp-calls-writer",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      traceToolDetails: false,
      timeoutMs: 200_000,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "lsp_search", "bash", "delete", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "composed",
              name: "codemode",
              arguments: { code: withTextResultChecks(script(peer)) },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done.")]),
      ],
    }).run("Take the call graph of a function while another session writes the file");
    const result = getToolResultText(run, "composed");
    expect(getToolExecution(run, "composed").isError, result).toBe(false);
    expect(await peer.writes()).toBeGreaterThan(ROUNDS);
  });
}, 300_000);
