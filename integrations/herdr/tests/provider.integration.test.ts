// This case checks read-before-write guards; the repository wrapper adds preflight reads.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";

const root = path.dirname(import.meta.dirname);
// Pattern: real Pi extensions example and GitHub provider test, with the external App bridge replaced.
// Contract: shared tools preserve timeline limits, history indexes and guarded message effects.
test.each([false, true])(
  "Herdr shared tools preserve history and message guards (providerFirst=%s)",
  async (providerFirst) => {
    const ide = await currentIde();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp", "herdr-provider-"));
    const fixture = path.join(root, "tests/fixtures/bridge.ts");
    try {
      const operations: [string, string, Record<string, unknown>][] = [
        ["guide", "read", { path: "docs:herdr" }],
        ["list", "read", { path: "herdr:" }],
        ["root-search", "search", { path: "herdr:", query: "bridge-fixture-agent" }],
        ["read-first", "write", { path: "herdr:t7", content: "premature-fixture" }],
        ["read", "read", { path: "herdr:t7" }],
        ["repeat", "read", { path: "herdr:t7" }],
        ["budget", "read", { path: "herdr:t8", views: ["budget:500"] }],
        ["search", "search", { path: "herdr:t9", query: "history-needle-fixture" }],
        ["history", "read", { path: "herdr:t9/history", offset: 8, limit: 2 }],
        ["history-read-first", "write", { path: "herdr:t9", content: "history-premature-fixture" }],
        ["send", "write", { path: "herdr:t7", content: "message-fixture" }],
        ["rotate", "herdr_fixture", { mode: "rotate" }],
        ["stale", "write", { path: "herdr:t7", content: "stale-fixture" }],
        ["reread", "read", { path: "herdr:t7" }],
        ["send-current", "write", { path: "herdr:t7", content: "current-fixture" }],
        ["waiting-state", "herdr_fixture", { mode: "waiting" }],
        ["waiting", "read", { path: "herdr:t7" }],
        ["blocked", "write", { path: "herdr:t7", content: "blocked-fixture" }],
        ["starting-state", "herdr_fixture", { mode: "starting" }],
        ["starting", "write", { path: "herdr:t7", content: "starting-fixture" }],
        ["error-state", "herdr_fixture", { mode: "error" }],
        ["error", "read", { path: "herdr:t7" }],
        ["regex", "search", { path: "herdr:t7", query: "regex:fixture" }],
        ["delete-read-first", "delete", { path: "herdr:t9" }],
        ["replace", "replace", { path: "herdr:t7", text: "replace-fixture" }],
        ["delete", "delete", { path: "herdr:t7" }],
        ["write-after-delete", "write", { path: "herdr:t7", content: "after-delete-fixture" }],
        ["unavailable-state", "herdr_fixture", { mode: "unavailable" }],
        ["unavailable", "read", { path: "herdr:t7" }],
      ];
      const result = await new PiIntegrationTest({
        testName: `herdr-provider-${providerFirst}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        extensions: providerFirst ? [fixture, ide.extension] : [ide.extension, fixture],
        tools: ["read", "search", "write", "delete", "replace", "herdr_fixture"],
        timeoutMs: 90000,
        conversation: [
          ...operations.map(([id, name, args]) =>
            assistantMessage(
              [
                toolCall({
                  id,
                  name,
                  arguments: args,
                  chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER },
                }),
              ],
              { stopReason: "toolUse" },
            ),
          ),
          assistantMessage([
            text("Fixture complete.", { chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } }),
          ]),
        ],
      }).run("Read and message Herdr agents through shared resources.");
      await ide.record(result.artifacts.directory);
      const failures: Record<string, string> = {
        "read-first": "HERDR_READ_FIRST",
        "history-read-first": "HERDR_READ_FIRST",
        stale: "HERDR_STALE_TARGET",
        blocked: "HERDR_SEND_REFUSED",
        starting: "HERDR_SEND_REFUSED",
        regex: "HERDR_LITERAL_ONLY",
        "delete-read-first": "HERDR_READ_FIRST",
        replace: "UNSUPPORTED_OPERATION",
        "write-after-delete": "HERDR_READ_FIRST",
        unavailable: "HERDR_UNAVAILABLE",
      };
      for (const [id] of operations) {
        expect(
          getToolExecution(result, id).isError,
          `${id}: ${getToolResultText(result, id)}`,
        ).toBe(id in failures);
        if (failures[id])
          expect(JSON.stringify(getToolExecution(result, id))).toContain(failures[id]);
      }
      for (const [call, operation] of [
        ["list", "agent.list"],
        ["read", "agent.inspect"],
        ["budget", "agent.inspect"],
        ["history", "agent.history"],
        ["root-search", "agent.list"],
        ["search", "agent.history"],
        ["send", "agent.send"],
        ["delete", "agent.remove"],
      ]) {
        const details = JSON.stringify(getToolExecutionDetails(getToolExecution(result, call)));
        expect(details).toContain(`receipt-${operation}`);
        expect(details).toContain("revision-fixture");
      }
      expect(getToolResultText(result, "list")).toContain("t7");
      const listed = getToolResultText(result, "list")
        .split("\n")
        .filter((line) => line.includes("bridge-fixture-agent"));
      const searched = getToolResultText(result, "root-search");
      expect(listed).toHaveLength(8);
      for (const line of listed) expect(searched).toContain(line);
      expect(getToolResultText(result, "root-search")).toContain("bridge-fixture-agent");
      expect(getToolResultText(result, "read")).toContain("bridge-reply-start");
      expect(getToolResultText(result, "read")).toContain("bridge-reply-end");
      expect(getToolResultText(result, "repeat")).not.toContain("bridge-reply-start");
      expect(getToolResultText(result, "repeat")).toContain("bridge-tool-fixture");
      expect(getToolResultText(result, "budget")).toContain("bridge-reply-start");
      expect(getToolResultText(result, "budget")).toContain("bridge-reply-end");
      expect(getToolResultText(result, "budget")).not.toContain("bridge-tool-fixture");
      expect(getToolResultText(result, "search")).toContain("herdr:t9/history:8");
      expect(getToolResultText(result, "history")).toContain("history-needle-fixture");
      expect(getToolResultText(result, "history")).toContain("history-row-8");
      expect(getToolResultText(result, "history")).not.toContain("history-row-9");
      expect(getToolResultText(result, "reread")).toContain("bridge-reply-start");
      for (const marker of ["bridge-question-fixture", "bridge-option-fixture"])
        expect(getToolResultText(result, "waiting")).toContain(marker);
      expect(getToolResultText(result, "error")).toContain("bridge-error-fixture");
      const requests = JSON.parse(
        await readFile(path.join(cwd, "bridge-requests.json"), "utf8"),
      ) as { name: string; args: Record<string, unknown> }[];
      expect(
        requests
          .filter((request) => request.name === "agent.send")
          .map((request) => request.args.message),
      ).toEqual([
        "message-fixture",
        "stale-fixture",
        "current-fixture",
        "blocked-fixture",
        "starting-fixture",
      ]);
      expect(
        requests
          .filter((request) => request.name === "agent.send")
          .map((request) => request.args.pid),
      ).toEqual([1, 1, 2, 2, 2]);
      expect(
        requests.filter((request) => ["agent.stop", "agent.remove"].includes(request.name)),
      ).toEqual([{ name: "agent.remove", args: { terminal: "t7", pid: 2, session: "target-2" } }]);
      expect(getToolResultText(result, "delete")).toContain("herdr:t7");
      expect(
        requests.find(
          (request) => request.name === "agent.history" && request.args.before !== undefined,
        )?.args,
      ).toMatchObject({ terminal: "t9", before: 9, limit: 2 });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120000,
);
