import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  deleteApproved,
  deleteIds,
  deleteSource,
  type DeleteFixtureState,
} from "./delete-resources-state.ts";

export interface DeleteDecision {
  source: string;
  answer: "allow" | "deny" | "cancel";
  channel: "confirm" | "select";
  before: number;
  after: number;
  waiting: boolean;
  hasUI: boolean;
}
export interface DeleteProbeDetails {
  hasUI: boolean;
  mode: string;
  decisions: DeleteDecision[];
  remembered: boolean;
  calls?: { path: string; isError: boolean; result: AgentToolResult<unknown> }[];
}
export const deleteTuiSteps: [string, string, Record<string, string | number>][] = [
  [
    "document-actions",
    "read",
    { path: deleteSource("document", deleteIds.document) + "#actions", limit: 2000 },
  ],
  [
    "skill-actions",
    "read",
    { path: deleteSource("workflow-skill", deleteIds.skill) + "#actions", limit: 2000 },
  ],
  [
    "template-actions",
    "read",
    {
      path: deleteSource("workflow-template", deleteIds.documentTemplate) + "#actions",
      limit: 2000,
    },
  ],
  [
    "alias-actions",
    "read",
    { path: deleteSource("template", deleteIds.templateAlias) + "#actions", limit: 2000 },
  ],
  ["refused", "delete", { path: deleteSource("document", deleteIds.refused) }],
  ["cancelled", "delete", { path: deleteSource("workflow-skill", deleteIds.cancelled) }],
  [
    "body-refused",
    "delete",
    { path: deleteSource("workflow-skill", deleteIds.preserved) + "#schema" },
  ],
  ["creation-refused", "delete", { path: "linear://example/document/new" }],
  ["collection-refused", "delete", { path: "linear://example/document" }],
  ["stale-result", "delete", { path: "RESULT#89500000000000000000000000000000" }],
  ["foreign", "delete", { path: deleteSource("workflow-template", deleteIds.foreign, "other") }],
  ["missing", "delete", { path: deleteSource("document", deleteIds.missing) }],
  ...deleteApproved.map(([kind, id], index): [string, string, Record<string, string | number>] => [
    "approved-" + index,
    "delete",
    { path: deleteSource(kind, id) },
  ]),
  ["unknown", "delete", { path: deleteSource("document", deleteIds.unknown) }],
  ["state", "verify_linear_delete_state", {}],
];

/** Control only the human answers and external HTTP; production hooks and ordinary tools do the work. */
export default function deleteProbe(pi: ExtensionAPI): void {
  const decisions: DeleteDecision[] = [];
  const waiting: { active?: boolean }[] = [];
  let remembered = false;
  const standalone = () =>
    pi.getAllTools().some((tool) => tool.name === "linear_read" && tool.exposure !== "hidden");
  const load = async (cwd: string): Promise<DeleteFixtureState> =>
    JSON.parse(await readFile(path.join(cwd, "delete-fixture.json"), "utf8"));
  pi.events.on("herdr:blocked", (event) => waiting.push(event as { active?: boolean }));
  pi.on("agent_start", () => {
    if (!standalone() || remembered) return;
    for (const category of ["delete_document", "delete_workflow_skill", "delete_workflow_template"])
      pi.appendEntry("pi-agent-ide/operation-permission/v1", {
        owner: "pi-agent-linear",
        category,
      });
    remembered = true;
  });
  // Load this fixture before Linear so its answer adapter exists when the production risk hook runs.
  pi.on("tool_call", (event, context) => {
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    const source = input.path;
    const answer = source.includes(deleteIds.refused)
      ? "deny"
      : source.includes(deleteIds.cancelled)
        ? "cancel"
        : "allow";
    const choose = async (channel: DeleteDecision["channel"], signal?: AbortSignal) => {
      const before = (await load(context.cwd)).mutations.length;
      const blocked = waiting.at(-1)?.active === true;
      assert(context.hasUI, "A headless operation attempted a dialog");
      if (context.mode === "tui") assert(blocked, "The dialog did not publish its waiting state");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const after = (await load(context.cwd)).mutations.length;
      assert.equal(after, before, "Deletion dispatched before its human decision");
      const decision = signal?.aborted ? "cancel" : answer;
      decisions.push({
        source,
        answer: decision,
        channel,
        before,
        after,
        waiting: blocked,
        hasUI: context.hasUI,
      });
      await writeFile(
        path.join(context.cwd, "delete-decisions.json"),
        JSON.stringify(decisions, null, 2),
      );
      return decision;
    };
    context.ui.confirm = async (_title, _message, options) =>
      (await choose("confirm", options?.signal)) === "allow";
    context.ui.select = async (_title, choices, options) => {
      const decision = await choose("select", options?.signal);
      // The shared service's ordered protocol is Deny, Allow once, optional session permission.
      return decision === "cancel" ? undefined : choices[decision === "allow" ? 1 : 0];
    };
  });
  pi.registerTool({
    name: "verify_linear_delete_state",
    label: "Inspect fixture deletion state",
    description: "Read independent controlled server state after ordinary typed Delete calls.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, context) {
      const state = await load(context.cwd);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              unknown: state.resources[deleteIds.unknown],
              preserved: state.resources[deleteIds.preserved],
            }),
          },
        ],
        details: {
          hasUI: context.hasUI,
          mode: context.mode,
          decisions,
          remembered,
        } satisfies DeleteProbeDetails,
      };
    },
  });
  pi.registerTool({
    name: "verify_linear_delete_headless",
    label: "Verify headless deletion policy",
    description:
      "Try typed deletion only against isolated fixtures in a genuine print-mode session.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, context) {
      assert.equal(context.hasUI, false);
      const calls: NonNullable<DeleteProbeDetails["calls"]> = [];
      for (const [kind, id] of deleteApproved) {
        const source = deleteSource(kind, id);
        const outcome = await context.executeTool(
          standalone() ? "linear_delete" : "delete",
          { path: source },
          { signal },
        );
        calls.push({ path: source, isError: !!outcome.isError, result: outcome.result });
      }
      const details = {
        hasUI: context.hasUI,
        mode: context.mode,
        decisions,
        remembered,
        calls,
      } satisfies DeleteProbeDetails;
      await writeFile(
        path.join(context.cwd, "delete-headless-calls.json"),
        JSON.stringify(details, null, 2),
      );
      return {
        content: [{ type: "text", text: "Controlled headless deletion attempts captured." }],
        details,
      };
    },
  });
  let responses = 0;
  pi.registerProvider("linear-delete-fixture", {
    name: "Local typed Delete fixture",
    api: "openai-completions",
    apiKey: "fixture",
    baseUrl: "https://delete-fixture.invalid",
    models: ["headless", "tui"].map((id) => ({
      id,
      name: "Controlled typed Delete",
      reasoning: false,
      input: ["text"] as "text"[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    })),
    streamSimple(model) {
      const local = standalone();
      const operations: [string, string, Record<string, string | number>][] = [
        ...(local
          ? [
              ["discover", "tool_search", { query: "linear", limit: 20 }] as [
                string,
                string,
                Record<string, string | number>,
              ],
            ]
          : []),
        ...deleteTuiSteps,
      ];
      const index = responses++;
      const step =
        model.id === "tui"
          ? operations[index]
          : index === 0
            ? (["headless-delete", "verify_linear_delete_headless", {}] as const)
            : undefined;
      const tool =
        step && (local && ["read", "delete"].includes(step[1]) ? "linear_" + step[1] : step[1]);
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: step
          ? [{ type: "toolCall", id: step[0], name: tool!, arguments: step[2] }]
          : [{ type: "text", text: "Controlled deletion fixture finished." }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: step ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: step ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
}
