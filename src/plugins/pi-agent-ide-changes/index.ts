import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { createCurrentChangePresenter } from "#src/current-change-presenter.js";
import { IndexMutationQueue } from "#src/index-mutation-queue.js";
import { LastTextTransactionStore } from "#src/last-text-transaction-store.js";
import { registerIndexChangeTools } from "#src/tool-index-change.js";
import { createUndoMutationTool } from "#src/tool-text-undo.js";

export default async function registerGitChanges(pi: ExtensionAPI): Promise<void> {
  if (process.argv.includes("--old-tools")) {
    return;
  }

  const executor = extensionGitExecutor(pi);
  const transactions = new LastTextTransactionStore();
  const indexQueue = new IndexMutationQueue();
  const presenter = createCurrentChangePresenter(executor);
  const anchorRegistration = createChangeAnchorRegistration(executor);
  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "current-git-changes",
    setup(api) {
      api.addTextPresenter({ presenter });
      api.describe(
        "Adds CHANGE anchors and Git index state to current changes in tracked text files. Use these anchors with undo, stage, and unstage.",
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
      api.addMutationTool(createUndoMutationTool(executor, transactions, indexQueue));
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
