import { Value } from "typebox/value";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { changesDoctorPlugin } from "#src/doctor-plugin.js";
import { CHANGE_ANCHOR_KIND, createChangeAnchorRegistration } from "#src/change-anchor.js";
import { extensionGitExecutor } from "#src/changes/git-changes-backend.js";
export type { GitCommandExecutor } from "#src/changes/git-changes-backend.js";
import { createCurrentChangePresenter } from "#src/current-change-presenter.js";
import { IndexMutationQueue } from "#src/index-mutation-queue.js";
import { LastTextTransactionStore } from "#src/last-text-transaction-store.js";
import {
  registerIndexChangeTools,
  createIndexChangeExecutor,
  indexChangeSchema,
} from "#src/tool-index-change.js";
import { createUndoMutationTool } from "#src/tool-text-undo.js";

export default function registerGitChanges(pi: ExtensionAPI): Promise<void> {
  return registerGitChangesWithExecutor(pi, extensionGitExecutor(pi));
}

/** Register Git views and mutations using the supplied owner-aware executor. */
export async function registerGitChangesWithExecutor(
  pi: ExtensionAPI,
  executor: ReturnType<typeof extensionGitExecutor>,
): Promise<void> {
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "git-changes",
      description: "Git change anchors, staging, and safe undo",
      triggers: ["stage", "unstage", "undo"].map((tool) => ({ tool })),
    }),
  ]);
  const transactions = new LastTextTransactionStore();
  const indexQueue = new IndexMutationQueue();
  const presenter = createCurrentChangePresenter(executor);
  const anchorRegistration = createChangeAnchorRegistration(executor);
  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "current-git-changes",
    setup(api) {
      api.addView({ view: "changes", presenter });
      api.describe(
        'views: ["changes"] — uncommitted edits in tracked files, staged/unstaged state, and CHANGE# anchors for stage, unstage and undo.',
      );
    },
  } satisfies ReadPlugin;
  const editorPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "current-git-changes",
    setup(api) {
      api.addAnchorResolver({
        ...anchorRegistration,
        kind: CHANGE_ANCHOR_KIND,
        type: "auxiliary",
      });
      api.onDidEdit((completion) => {
        transactions.observe(completion);
      });
      api.addMutationTool(
        createUndoMutationTool(executor, transactions, indexQueue, api.restoreApplyUndo),
      );
      for (const action of ["stage", "unstage"] as const) {
        const execute = createIndexChangeExecutor(action, executor, indexQueue);
        api.addScriptIndexOperation({
          name: action,
          parameters: indexChangeSchema,
          execute: (input, signal, context) =>
            execute(Value.Decode(indexChangeSchema, input), signal, context),
        });
      }
      api.addTextPresenter({ presenter });
    },
  } satisfies TextEditorPlugin;

  await Promise.all([
    connectDoctorPlugin(pi, changesDoctorPlugin),
    connectReadPlugin(pi, readPlugin),
    connectTextEditorPlugin(pi, editorPlugin),
  ]);
  registerIndexChangeTools(pi, executor, indexQueue);
}
