import { withDeclarationSelections } from "./declaration-selections.ts";
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
  arguments: { path: "fixture:declaration:task.ts#count#name", text: "total" },
});
const rejected = toolCall({
  id: "rejected-rename",
  name: "replace",
  arguments: { path: { id: "fixture:declaration:task.ts#count#name" }, text: "" },
});
const invalidRequests = [
  { id: "whitespace-rename", arguments: { text: " \t" } },
  { id: "malformed-rename", arguments: { start: "count", text: "total" } },
  { id: "end-rename", arguments: { end: "count", text: "total" } },
];
const invalidCalls = invalidRequests.map(({ id, arguments: args }) =>
  toolCall({
    id,
    name: "replace",
    // Substitute the issued capture in the provider stream, before streamed selector guards.
    arguments: { path: "$issued-item:read-symbol", ...args },
  }),
);
const inspect = toolCall({ id: "after-rejection", name: "read", arguments: { path: "task.ts" } });
const calls =
  mode === "direct"
    ? [read, rejected, ...invalidCalls, inspect, rename]
    : [
        toolCall({
          id: "compose",
          name: "codemode",
          arguments: {
            code: `const declaration = await tools.lsp_search({declaration:"task.ts#count"});
const name = declaration.matches[0].captures.name[0];
if (await tools.replace({path:{id:name.id.replace(/^RESULT#/, "")},text:""}) !== null) throw Error("Invalid rename succeeded");
for (const args of ${JSON.stringify(invalidRequests.map(({ arguments: args }) => args))}) {
  if (await tools.replace({path:name,...args}) !== null) throw Error("Invalid rename succeeded");
}
text(await tools.read({path:"task.ts"}));
text(await tools.replace({path:name,text:"total"}));`,
          },
        }),
      ];
const run = await new PiIntegrationTest(
  withDeclarationSelections({
    testName: `capability-semantic-rename-${mode}`,
    artifactsDir: "/state/results",
    cwd,
    // Use the checkout's pinned host from the read-only source mount, not a global installation.
    piCommand: "/source/node_modules/.bin/pi",
    transport: mode === "direct" ? "tui" : "rpc",
    rawMode: false,
    timeoutMs: 90_000,
    extensions: [
      "/source/tests/integration/fixtures/issued-reference-provider.ts",
      "/source/src/pi-agent-ide.ts",
      "builtin:codemode",
    ],
    tools: ["read", "lsp_search", "replace", "codemode"],
    conversation: [
      ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
      assistantMessage([text("Done")]),
    ],
  }),
).run(task.prompt ?? "Read a symbol and rename it through LSP");
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
          !["rejected-rename", ...invalidRequests.map(({ id }) => id)].includes(call.id) &&
          getToolExecution(run, call.id).isError,
      )
      .map((call) => call.id),
    rejectedCount: failed.length,
    refusals: failed.map((event) => {
      const details = event.result?.details as
        | {
            results?: { data: { errors?: { path: string; code: string; reason: string }[] } }[];
            effect?: string;
          }
        | undefined;
      return {
        errors: details?.results?.flatMap(({ data }) => data.errors ?? []),
        effect: details?.effect,
        text: resultText(event),
      };
    }),
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
