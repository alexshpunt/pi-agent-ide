import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { capabilityCases } from "#capabilities/cases.ts";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

const original =
  "template <typename T>\nT one(T v) {\n  return v;\n}\ntemplate <typename T>\nT two(T v) {\n  return v;\n}\n";

const final = "template <typename T>\n  return v;\n}\n";

const complete = { kind: "fixed", size: Number.MAX_SAFE_INTEGER } as const;

test.each(["direct", "codemode"] as const)(
  "%s: a broad Read scope keeps the surviving duplicate block and rejects deleted anchors",
  async (route) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "task.txt"), original);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await mkdir(path.join(cwd, ".pi-agent"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
      );
      const result = await new PiIntegrationTest({
        testName: `surviving-read-scope-${route}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        transport: route === "direct" ? "tui" : "rpc",
        rawMode: false,
        environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
        extensions: [
          path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
        ],
        tools: ["read", "delete", "codemode"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "anchors",
                name: "read",
                arguments: { path: "task.txt", views: ["anchors"] },
                chunks: complete,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          ...(route === "direct"
            ? [
                assistantMessage(
                  [
                    toolCall({
                      id: "scope",
                      name: "read",
                      arguments: { path: "task.txt" },
                      chunks: complete,
                    }),
                  ],
                  { stopReason: "toolUse" },
                ),
                ...[
                  {
                    id: "deleted",
                    start: "$issued-anchor:anchors:1",
                    end: "$issued-anchor:anchors:4",
                  },
                  { id: "stale", start: "$issued-anchor:anchors:1" },
                  { id: "ambiguous", start: "$issued-anchor:anchors:3" },
                  { id: "survivor", start: "$issued-anchor:anchors:6" },
                ].map(({ id, ...selectors }) =>
                  assistantMessage(
                    [
                      toolCall({
                        id,
                        name: "delete",
                        arguments: { path: { id: "$issued-uuid:scope" }, ...selectors },
                        chunks: complete,
                      }),
                    ],
                    { stopReason: "toolUse" },
                  ),
                ),
              ]
            : [
                { id: "scope", code: 'store("scope", await tools.read({ path: "task.txt" }));' },
                {
                  id: "deleted",
                  code: 'await tools.delete({ path: load("scope"), start: "$issued-anchor:anchors:1", end: "$issued-anchor:anchors:4" });',
                },
                {
                  id: "stale",
                  code: 'await tools.delete({ path: load("scope"), start: "$issued-anchor:anchors:1" });',
                },
                {
                  id: "ambiguous",
                  code: 'await tools.delete({ path: load("scope"), start: "$issued-anchor:anchors:3" });',
                },
                {
                  id: "survivor",
                  code: 'await tools.delete({ path: load("scope"), start: "$issued-anchor:anchors:6" });',
                },
              ].map(({ id, code }) =>
                assistantMessage(
                  [toolCall({ id, name: "codemode", arguments: { code }, chunks: complete })],
                  { stopReason: "toolUse" },
                ),
              )),
          assistantMessage([text("Done", { chunks: complete })]),
        ],
      }).run("Delete the first duplicate block, refuse its old anchors, and edit the survivor.");
      if (route === "direct") {
        for (const id of ["anchors", "deleted", "survivor"])
          expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
        for (const id of ["stale", "ambiguous"])
          expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(true);
        const task = capabilityCases.find(({ id }) => id === "result-selector-surviving-scope");
        if (task === undefined) throw new Error("Missing surviving-scope capability case");
        const events = result.traceEvents.flatMap((entry) =>
          "event" in entry && entry.event && typeof entry.event === "object"
            ? [entry.event as RunEvent]
            : [],
        );
        expect(validateRoute(task, events, "direct")).toEqual({ passed: true, reasons: [] });
      } else {
        for (const id of ["scope", "deleted", "stale", "ambiguous", "survivor"])
          expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
        const events = result.traceEvents.flatMap((entry) =>
          "event" in entry && entry.event && typeof entry.event === "object"
            ? [entry.event as RunEvent]
            : [],
        );
        const deletions = new Set(
          events.flatMap((event) =>
            event.type === "tool_execution_start" && event.toolName === "delete"
              ? [event.toolCallId]
              : [],
          ),
        );
        expect(
          events.flatMap((event) =>
            event.type === "tool_execution_end" && deletions.has(event.toolCallId)
              ? [event.isError ?? false]
              : [],
          ),
        ).toEqual([false, true, true, false]);
      }
      expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe(final);
    });
  },
);
