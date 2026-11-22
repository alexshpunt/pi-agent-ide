import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
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
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.ts";

// A plain workspace-symbol query has no inner navigation deadline.
const deadlineMs = 20_000;
const source = "note.ts";
const slowQuery = "lsp-deadline-fixture";
const requestLog = "lsp-requests.jsonl";

interface RequestEvent {
  readonly event: "held" | "cancelled" | "served";
  readonly id: number;
  readonly serverPid: number;
  readonly pending: readonly number[];
}

test("a stalled workspace-symbol request reaches its deadline, cancels and lets Codemode continue", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(path.join(cwd, source), 'const label = "café";\n');
    const configDir = path.join(cwd, ".pi/pi-agent-ide");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "lsp-servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          owned: {
            command: ["python3", path.resolve("tests/integration/fixtures/lsp-owner-server.py")],
            rootMarkers: [],
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: [],
            initializationOptions: {
              ownerHoldSymbolQuery: slowQuery,
              ownerSymbolRequestLog: requestLog,
            },
          },
        },
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "lsp-tool-deadline",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      environment: { PI_AGENT_IDE_LSP_LINGER_MS: "0" },
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["lsp_search", "codemode"],
      timeoutMs: 75_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "deadline",
              name: "codemode",
              arguments: {
                code: `// @options: {"timeout_ms": 45000}
const start = Date.now();
const stalled = await tools.lsp_search({ query: ${JSON.stringify(slowQuery)}, path: ${JSON.stringify(source)} });
const elapsed = Date.now() - start;
if (stalled !== null) throw Error("The stalled request did not return a failed-call value");
const next = await tools.lsp_search({ query: "label", path: ${JSON.stringify(source)} });
text("retry=" + next.matches.map((match) => match.text).join(",") + "; elapsed_ms=" + elapsed);`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Find the stalled workspace symbol, then find label.");
    const scriptResult = getToolResultText(run, "deadline");
    expect(getToolExecution(run, "deadline").isError, scriptResult).toBe(false);
    const elapsed = Number(/retry=label; elapsed_ms=(\d+)/u.exec(scriptResult)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(deadlineMs - 1_000);
    expect(elapsed).toBeLessThan(deadlineMs + 5_000);
    const timedOut = getToolExecution(run, "deadline/1");
    expect(timedOut.isError).toBe(true);
    expect(getToolExecutionDetails(timedOut)).toMatchObject({
      code: "TOOL_TIMEOUT",
      tool: "lsp_search",
      target: source,
      timeoutMs: deadlineMs,
    });

    const events = (await readFile(path.join(cwd, requestLog), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as RequestEvent);
    const [held, cancelled, served] = events;
    expect(events.map((event) => event.event)).toEqual(["held", "cancelled", "served"]);
    expect(held?.id).toBeTypeOf("number");
    expect(held?.serverPid).toBeGreaterThan(0);
    expect(held?.pending).toEqual([held?.id]);
    expect(cancelled).toMatchObject({ id: held?.id, serverPid: held?.serverPid, pending: [] });
    expect(served).toMatchObject({ serverPid: held?.serverPid, pending: [] });
    expect(served?.id).not.toBe(held?.id);
  });
}, 90_000);
