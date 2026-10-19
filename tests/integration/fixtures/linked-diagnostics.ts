import { appendFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdeDiagnosticContext, type IdeDiagnosticReport } from "pi-agent-ide/api/plugin-protocol";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "pi-agent-text-editor/api/plugin-protocol";

/** Hold reports until all edit versions have completed, including deferred native batches. */
export default async function linkedDiagnostics(pi: ExtensionAPI): Promise<void> {
  const jobs: { context: IdeDiagnosticContext; finish(report: IdeDiagnosticReport): void }[] = [];
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL, apiVersion: TEXT_EDITOR_API_VERSION, id: "owned-edit-observer",
    setup(api) {
      api.onDidEdit(async (completion) => {
        await appendFile(path.join(completion.cwd, "edit-owners.jsonl"), JSON.stringify({
          file: path.basename(completion.resourceSource), content: completion.after.content,
          parentToolCallId: completion.parentToolCallId, postProcessing: completion.postProcessing,
        }) + "\n");
      });
    },
  });
  await connectIdePlugin(pi, {
    protocol: IDE_PROTOCOL, apiVersion: IDE_API_VERSION, id: "owned-diagnostic-provider",
    setup(api) {
      api.addDiagnosticSource({ id: "owned-checker", diagnose: (_file, context) => new Promise((finish) => { jobs.push({context, finish}); }) });
    },
  });
  pi.registerTool({
    name: "release_linked_diagnostics", label: "Release diagnostic reports", description: "Finish delayed diagnostic checks.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const deadline = Date.now() + 12_000;
      while (jobs.length < 4 && Date.now() < deadline) await delay(10);
      if (jobs.length < 4) throw Error(`Expected four diagnostic snapshots, got ${jobs.length}`);
      for (const job of jobs) job.finish({ status: "ready", diagnostics: [{ line: 1, column: 1, severity: "warning", code: "owned", message: job.context.content }] });
      const summaries = () => ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "ide-diagnostic-summary");
      while (summaries().length < 2 && Date.now() < deadline) await delay(10);
      if (summaries().length !== 2) throw Error(`Expected two owned summaries, got ${summaries().length}`);
      return { content: [{type:"text",text:"Reports delivered after all edits."}], details: { snapshots: jobs.length, cancelled: jobs.filter(job=>job.context.signal.aborted).length } };
    },
  });
}
