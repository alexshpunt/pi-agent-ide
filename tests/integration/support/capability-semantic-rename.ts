import { writeFile, mkdir } from "node:fs/promises";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { capabilityCases } from "#capabilities/cases.ts";
import { resultText, validateRoute, type RunEvent } from "#capabilities/validation.ts";

const mode = process.argv[2];
if (mode !== "direct" && mode !== "codemode") throw Error("Choose direct or codemode");
const task = capabilityCases.find((task) => task.id === "lsp-rename");
if (!task) throw Error("Missing semantic rename case");
const cwd = "/workspace/fixture";
await mkdir(`${cwd}/.pi`, { recursive: true });
await writeFile(`${cwd}/.pi/settings.json`, JSON.stringify({ codemode: { mode: "on" } }));
const read = toolCall({
  id: "read-symbol",
  name: "lsp_search",
  arguments: { declaration: "task.ts#count" },
});
const rename = toolCall({
  id: "rename",
  name: "replace",
  arguments: { path: "symbol:task.ts#count#name", text: "total" },
});
const rejected = toolCall({
  id: "rejected-rename",
  name: "replace",
  arguments: { path: "symbol:task.ts#count#name", text: "" },
});
const malformed = toolCall({
  id: "malformed-rename",
  name: "replace",
  arguments: { path: "symbol:task.ts#count#total", text: "total" },
});
const inspect = toolCall({ id: "after-rejection", name: "read", arguments: { path: "task.ts" } });
const calls =
  mode === "direct"
    ? [read, rejected, malformed, inspect, rename]
    : [
        toolCall({
          id: "compose",
          name: "codemode",
          arguments: {
            code: 'await tools.lsp_search({declaration:"task.ts#count"}); const rejected = (await tools.replace({path:"symbol:task.ts#count#name",text:""})) === null; if(!rejected) throw Error("Invalid rename succeeded"); const malformed = (await tools.replace({path:"symbol:task.ts#count#total",text:"total"})) === null; if(!malformed) throw Error("Malformed rename succeeded"); text(await tools.read({path:"task.ts"})); text(await tools.replace({path:"symbol:task.ts#count#name",text:"total"}));',
          },
        }),
      ];
const run = await new PiIntegrationTest({
  testName: `capability-semantic-rename-${mode}`,
  artifactsDir: "/state/results",
  cwd,
  // Use the checkout's pinned host from the read-only source mount, not a global installation.
  piCommand: "/source/node_modules/.bin/pi",
  transport: mode === "direct" ? "tui" : "rpc",
  rawMode: false,
  timeoutMs: 90_000,
  extensions: ["/source/src/pi-agent-ide.ts", "builtin:codemode"],
  tools: ["read", "lsp_search", "replace", "codemode"],
  conversation: [
    ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
    assistantMessage([text("Done")]),
  ],
}).run(task.prompt ?? "Read a symbol and rename it through LSP");
const events = run.traceEvents.flatMap((entry) =>
  "event" in entry && entry.event && typeof entry.event === "object"
    ? [entry.event as RunEvent]
    : [],
);
const executions = events.filter((event) => event.type === "tool_execution_end");
const failed = executions.filter((event) => event.toolName === "replace" && event.isError);
const afterRejection = executions.find(
  (event) => event.toolName === "read" && event.toolCallId !== "read-symbol",
);
const renames = executions.filter((event) => event.toolName === "replace" && !event.isError);
console.log(
  JSON.stringify({
    route: validateRoute(task, events, mode),
    failures: executions
      .filter((event) => event.isError)
      .map((event) => ({ tool: event.toolName, id: event.toolCallId, text: resultText(event) })),
    errors: calls
      .filter(
        (call) =>
          !["rejected-rename", "malformed-rename"].includes(call.id) &&
          getToolExecution(run, call.id).isError,
      )
      .map((call) => call.id),
    rejectedCount: failed.length,
    renameHintPaths: failed
      .filter((event) =>
        events.some(
          (start) =>
            start.type === "tool_execution_start" &&
            start.toolCallId === event.toolCallId &&
            start.args?.path === "symbol:task.ts#count#total",
        ),
      )
      .flatMap((event) => resultText(event).match(/symbol:task\.ts#count#name/gu) ?? []),
    unchangedAfterRejection: afterRejection?.result?.content?.some((block) =>
      block.text?.includes(task.files?.["task.ts"]?.trim() ?? ""),
    ),
    renameModes: renames.map((event) => {
      const result = event.result as
        | { details?: { metadata?: { semanticEdit?: { mode?: string } } } }
        | undefined;
      return result?.details?.metadata?.semanticEdit?.mode;
    }),
  }),
);
