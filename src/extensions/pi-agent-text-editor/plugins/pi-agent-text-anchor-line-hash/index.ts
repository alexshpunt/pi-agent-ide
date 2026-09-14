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
  TEXT_POSITION_ANCHOR_KIND,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { createLineHashAnchorResolver } from "./src/anchor.js";
import { createLineHashPresenter } from "./src/read-handler.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerLineHashTextAnchor(pi: ExtensionAPI): Promise<void> {
  const presenter = createLineHashPresenter();
  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "text-anchor-line-hash",
    setup(api) {
      api.addView({ view: "anchors", presenter });
      api.describe(
        'views: ["anchors"] — LINE#HASH references for editing individual source lines.',
      );
    },
  } satisfies ReadPlugin;
  const editorPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "text-anchor-line-hash",
    setup(api) {
      api.addAnchorResolver({
        resolver: createLineHashAnchorResolver(),
        kind: TEXT_POSITION_ANCHOR_KIND,
        type: "major",
      });
      api.addTextPresenter({ presenter });
    },
  } satisfies TextEditorPlugin;

  await Promise.all([connectReadPlugin(pi, readPlugin), connectTextEditorPlugin(pi, editorPlugin)]);
}
