import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-ide/api/text-editor";
import {
  connectLinearPermissionGate,
  createLinearOperationHandlers,
} from "#linear/operation-actions.ts";
import { createLinearFields } from "#linear/fields.ts";
import type { LinearOperationBackend } from "#linear/operation-backend.ts";

interface FixtureState {
  waiting: unknown[];
  decisions: {
    title: string;
    message: string;
    approved: boolean;
    mutationsBefore: number;
    blockedAtOpen: unknown;
    cancelled: boolean;
  }[];
  mutations: { operation: string; input: Readonly<Record<string, unknown>> }[];
  observations: { mode: string; hasUI: boolean }[];
}

/** Controlled backend and host decisions; no credentials, MCP backend or remote HTTP involved. */
export default async function approvalProof(pi: ExtensionAPI): Promise<void> {
  const state: FixtureState = { waiting: [], decisions: [], mutations: [], observations: [] };
  let abortDialog: (() => void) | undefined;
  let uiCompletion: Promise<void> = Promise.resolve();
  pi.events.on("herdr:blocked", (event) => state.waiting.push(event));
  pi.on("tool_call", (_event, context) => {
    const confirm = async (title: string, message: string, options?: { signal?: AbortSignal }) => {
      const mutationsBefore = state.mutations.length;
      const blockedAtOpen = state.waiting.at(-1);
      if (context.mode === "tui" && !(blockedAtOpen as { active?: boolean })?.active)
        throw new Error("Shared approval opened before the waiting event");
      const approved = !message.includes("refuse");
      if (message.includes("/turn-abort#merge")) context.abort();
      else if (message.includes("abort")) abortDialog?.();
      // Keep the decision asynchronous to expose a mutation dispatched before permission.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (state.mutations.length !== mutationsBefore)
        throw new Error("Mutation preceded user decision");
      const cancelled = options?.signal?.aborted ?? false;
      state.decisions.push({ title, message, approved, mutationsBefore, blockedAtOpen, cancelled });
      if (message.includes("fail")) throw new Error("Controlled dialog failure");
      return approved;
    };
    context.ui.select = (dialog, choices, options) => {
      const [title, ...lines] = dialog.split("\n");
      const message = lines.join("\n");
      const decision = confirm(title ?? "", message, options).then((approved) => {
        const answer = !approved ? "Deny" : message.includes("remember-session") ? "Allow for session" : "Allow once";
        if (!choices.includes(answer)) throw new Error(`Missing approval choice: ${answer}`);
        return answer;
      });
      uiCompletion = decision.then(
        () => undefined,
        () => undefined,
      );
      return decision;
    };
  });
  pi.on("agent_settled", async (_event, context) => {
    // Capture the deliberately late yes after cancellation, not just the race winner.
    await uiCompletion;
    await writeFile(path.join(context.cwd, "approval-state.json"), JSON.stringify(state, null, 2));
  });
  const requirePermit = connectLinearPermissionGate(pi);
  const backend: LinearOperationBackend = {
    capabilities: async () => [
      {
        name: "get_diff",
        inputSchema: { type: "object", properties: { urlOrId: { type: "string" } } },
        annotations: { readOnlyHint: true },
      },
      {
        name: "update_diff",
        inputSchema: {
          type: "object",
          properties: { urlOrId: { type: "string" }, title: { type: "string" } },
        },
        annotations: {},
      },
      {
        name: "merge_diff",
        inputSchema: {
          type: "object",
          properties: { urlOrId: { type: "string" }, note: { type: "string" } },
        },
        annotations: {},
      },
      {
        name: "delete_comment",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        annotations: {},
      },
      {
        name: "save_comment",
        inputSchema: { type: "object", properties: { body: { type: "string" } } },
        annotations: {},
      },
    ],
    async invoke(workspace, operation, input) {
      if (operation === "get_diff")
        return {
          workspace,
          operation,
          effect: "applied",
          data: { id: input.urlOrId, title: "Controlled diff" },
        };
      state.mutations.push({ operation, input });
      return {
        workspace,
        operation,
        effect: "applied",
        data: {
          id:
            operation === "save_comment"
              ? "11111111-1111-4111-8111-111111111111"
              : (input.id ?? input.urlOrId),
        },
      };
    },
  };
  const fields = createLinearFields(backend, requirePermit);
  const handlers = createLinearOperationHandlers(backend, requirePermit);
  pi.on("tool_result", async (_event, context) => {
    await writeFile(path.join(context.cwd, "approval-state.json"), JSON.stringify(state, null, 2));
  });

  pi.registerTool({
    name: "linear_approval_probe",
    label: "Verify Linear approval lifecycle",
    description: "Test-only probe for cancellation, refusal and consumed permits through real Pi.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, context) {
      state.observations.push({ mode: context.mode, hasUI: context.hasUI });
      const calls: { path: string; isError: boolean; text: string }[] = [];
      for (const target of context.hasUI ? ["abort", "fail"] : ["headless", "headless-refuse"]) {
        const controller = new AbortController();
        abortDialog = () => controller.abort();
        const source = `linear://example/diff/${target}#merge`;
        const outcome = await context.executeTool(
          "write",
          { path: source, content: JSON.stringify({ note: target }) },
          { signal: context.hasUI ? controller.signal : signal },
        );
        abortDialog = undefined;
        calls.push({
          path: source,
          isError: !!outcome.isError,
          text: outcome.result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        });
      }
      if (!context.hasUI) {
        const source = "linear://example/comment/headless-refuse";
        const outcome = await context.executeTool("delete", { path: source }, { signal });
        calls.push({
          path: source,
          isError: !!outcome.isError,
          text: outcome.result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        });
      }
      if (!context.hasUI) {
        const source = "linear://example/diff/identity-override#merge";
        const outcome = await context.executeTool("write", {
          path: source, content: '{"urlOrId":"different-target"}',
        }, { signal });
        calls.push({
          path: source, isError: !!outcome.isError,
          text: outcome.result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
        });
      }
      const consumed = [
        ["linear://example/diff/direct-yes#merge", '{"note":"direct-yes"}'],
        ["linear://example/diff/script-yes#merge", '{"note":"script-yes"}'],
        ["linear://example/diff/other#merge", '{"note":"direct-yes"}'],
        ["linear://example/diff/direct-yes#merge", '{"note":"different"}'],
      ].map(([source, content]) => {
        try {
          requirePermit(source!, content!);
          return false;
        } catch {
          return true;
        }
      });
      return {
        content: [{ type: "text", text: "Linear approval lifecycle captured." }],
        details: { mode: context.mode, hasUI: context.hasUI, calls, consumed },
      };
    },
  });

  let response = 0;
  pi.registerProvider("linear-approval-fixture", {
    api: "openai-completions",
    apiKey: "fixture-only-no-network",
    baseUrl: "https://fixture.invalid",
    models: [
      {
        id: "headless",
        name: "Scripted headless approval",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model) {
      const first = response++ === 0;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: first
          ? [
              {
                type: "toolCall",
                id: "headless-approval",
                name: "linear_approval_probe",
                arguments: {},
              },
            ]
          : [{ type: "text", text: "Headless verification finished." }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: first ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
  await Promise.all([
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: "linear-approval-proof",
      setup(api) {
        api.addResolver({ resolver: fields.resolver, priority: -100 });
      },
    }),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "linear-approval-proof",
      setup(api) {
        api.addResolver({ resolver: fields.resolver, priority: -100 });
        api.tool("write").addSemanticHandler(handlers.write);
        api.addFileOperationResolver(handlers.fileOperations);
      },
    }),
  ]);
}
