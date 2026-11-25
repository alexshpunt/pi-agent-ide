import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  connectLinearPermissionGate,
  createLinearOperationHandlers,
} from "#linear/operation-actions.ts";
import { createStandaloneResources } from "#linear/standalone-resources.ts";
import { registerStandaloneTools } from "#linear/standalone-tools.ts";
import { loadLinearGuides } from "#linear/guidance.ts";

/** Control only the backend and human answer; use the production standalone tools and gate. */
export default async function standaloneApproval(pi: ExtensionAPI) {
  const mutations: unknown[] = [];
  const decisions: unknown[] = [];
  const waiting: unknown[] = [];
  pi.events.on("herdr:blocked", (value) => waiting.push(value));
  pi.on("tool_call", (_event, ctx) => {
    ctx.ui.confirm = async (_title, message, options) => {
      const before = mutations.length;
      if (ctx.mode === "tui" && (waiting.at(-1) as { active?: boolean })?.active !== true)
        throw new Error("Missing waiting state");
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (mutations.length !== before) throw new Error("Mutation preceded permission");
      decisions.push({ message, before });
      return !message.includes("refuse") && !options?.signal?.aborted;
    };
  });
  const handlers = createLinearOperationHandlers(
    {
      capabilities: async () => [
        {
          name: "get_diff",
          inputSchema: { type: "object", properties: { urlOrId: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: "merge_diff",
          inputSchema: {
            type: "object",
            properties: { urlOrId: { type: "string" }, note: { type: "string" } },
          },
          annotations: {},
        },
      ],
      invoke: async (workspace, operation, input) => {
        if (operation !== "get_diff") mutations.push({ workspace, operation, input });
        return {
          workspace,
          operation,
          effect: "applied",
          data: { id: input.urlOrId, title: "Fixture" },
        };
      },
    },
    connectLinearPermissionGate(pi, () => true),
  );
  const resources = createStandaloneResources({
    resolvers: [handlers.fields.resolver],
    write: [handlers.write],
    insert: [handlers.insert],
    fileOperations: [handlers.fileOperations],
    guides: await loadLinearGuides(),
  });
  pi.on("session_start", () => registerStandaloneTools(pi, resources));
  pi.on("agent_settled", async (_event, ctx) => {
    await writeFile(
      path.join(ctx.cwd, "standalone-approval.json"),
      JSON.stringify({ mutations, decisions, waiting }),
    );
  });
}
