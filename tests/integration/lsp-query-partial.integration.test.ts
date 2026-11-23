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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.ts";
import { expect, test } from "vitest";

const script = `
function check(ok, value) { if (!ok) throw Error(JSON.stringify(value)); }
const mixed = await tools.lsp_search({ query: "label-family", path: "note.ts", references: true });
check(mixed?.complete === false, mixed);
check(JSON.stringify(mixed.skipped) === JSON.stringify([{name:"removedLabel",path:"note.ts"}]), mixed);
check(JSON.stringify(mixed.matches.map(({path, line, text}) => [path, line, text])) ===
  JSON.stringify([["note.ts", 1, "label"], ["reference.ts", 1, "label"]]), mixed);
const selected = await tools.read({ path: mixed.matches[1] });
check(selected?.text.includes("label"), selected);
const allSkipped = await tools.lsp_search({ query: "missing-label", path: "note.ts" });
check(allSkipped?.complete === false && allSkipped.matches.length === 0 &&
  JSON.stringify(allSkipped.skipped) === JSON.stringify(mixed.skipped), allSkipped);
`;

test("lsp_search keeps usable matches when a workspace symbol cannot be located", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(path.join(cwd, "note.ts"), 'const label = "café";\n');
    await writeFile(path.join(cwd, "reference.ts"), "void (label);\n");
    const config = path.join(cwd, ".pi/pi-agent-ide");
    await mkdir(config, { recursive: true });
    await writeFile(
      path.join(config, "lsp-servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          owned: {
            command: ["python3", path.resolve("tests/integration/fixtures/lsp-owner-server.py")],
            rootMarkers: [],
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: [],
          },
        },
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "lsp-query-partial",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      tuiSize: { cols: 150, rows: 60 },
      environment: { PI_AGENT_IDE_LSP_LINGER_MS: "0" },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["lsp_search", "read", "codemode"],
      timeoutMs: 45_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "direct",
              name: "lsp_search",
              arguments: { query: "label-family", path: "note.ts" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "script",
              name: "codemode",
              arguments: { code: script },
              chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done.")]),
      ],
    }).run("Find the label symbols, then navigate to their references.");

    const direct = getToolResultText(run, "direct");
    expect(getToolExecution(run, "direct").isError, direct).toBe(false);
    expect(direct).toMatch(/SEARCH#\S+:1:match note\.ts:1:7\b/u);
    expect(direct).not.toContain(":all:match");
    expect(direct).not.toContain("reference.ts");
    expect(direct).toContain("removedLabel");
    expect(run.tuiRenderedOutput).toContain("removedLabel");
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
  });
}, 60_000);
