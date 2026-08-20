import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { registerMutationRenderers } from "./src/renderer.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerTextEditorRenderer(pi: ExtensionAPI): Promise<void> {
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "text-editor-renderer",
    setup: registerMutationRenderers,
  } satisfies TextEditorPlugin;

  await connectTextEditorPlugin(pi, plugin);
}
