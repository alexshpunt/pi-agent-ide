import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";
import { connectTextEditorPlugin, TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "pi-agent-ide/api/text-editor";
import { connectLinearDomainReadRecovery, createLinearDomainResolver } from "#linear/domain-read.ts";
import { connectLinearOperationReceipts, createLinearOperationHandlers } from "#linear/operation-actions.ts";
import type { LinearOperationBackend } from "#linear/operation-backend.ts";

const id = "a8852949-289a-454e-8950-ced239500f26";

/** Exercise production milestone handlers without changing a real Linear workspace. */
export default async function milestoneLinks(pi: ExtensionAPI): Promise<void> {
  const backend: LinearOperationBackend = {
    capabilities: async () => [
      { name: "save_milestone", inputSchema: { type: "object", properties: { id: { type: "string" }, project: { type: "string" }, name: { type: "string" } }, required: ["project"] }, annotations: {} },
      { name: "get_milestone", inputSchema: { type: "object", properties: { project: { type: "string" }, query: { type: "string" } }, required: ["project", "query"] }, annotations: { readOnlyHint: true } },
    ],
    async invoke(workspace, operation, input, cwd) {
      if (workspace !== "example") throw new Error("Fixture workspace required");
      await appendFile(path.join(cwd, "milestone-operations.jsonl"), JSON.stringify({ operation, input }) + "\n");
      return { workspace, operation, effect: "applied", data: { id, name: "First milestone" } };
    },
  };
  const handlers = createLinearOperationHandlers(backend, () => { throw new Error("Unexpected approval"); });
  const domain = createLinearDomainResolver(backend);
  // Do not intercept real workspace resources during a live verification.
  const resolver: typeof domain = {
    id: "milestone-links-proof",
    tryResolve(source, context) {
      return source.startsWith("linear://example/milestone/")
        ? domain.tryResolve(source, context)
        : Promise.resolve({ kind: "not-handled" });
    },
  };
  connectLinearOperationReceipts(pi);
  connectLinearDomainReadRecovery(pi);
  await Promise.all([
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL, apiVersion: TEXT_EDITOR_API_VERSION, id: "milestone-links-proof",
      setup(api) {
        api.addResolver({ resolver: handlers.fields.resolver, priority: -500 });
        api.addResolver({ resolver, priority: -500 });
        api.tool("write").addSemanticHandler(handlers.write);
      },
    }),
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL, apiVersion: READ_API_VERSION, id: "milestone-links-proof",
      setup(api) { api.addResolver({ resolver, priority: -500 }); },
    }),
  ]);
}
