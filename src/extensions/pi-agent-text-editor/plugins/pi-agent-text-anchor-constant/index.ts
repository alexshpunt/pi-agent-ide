import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_POSITION_ANCHOR_KIND,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { createConstantTextAnchorResolver } from "./src/resolver.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerConstantTextAnchors(pi: ExtensionAPI): Promise<void> {
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "text-anchor-constant",
    setup(api) {
      api.addAnchorResolver({
        resolver: createConstantTextAnchorResolver(),
        kind: TEXT_POSITION_ANCHOR_KIND,
        type: "constant",
      });
    },
  } satisfies TextEditorPlugin;

  await connectTextEditorPlugin(pi, plugin);
}
