import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { createMutationAnimationPressure } from "./src/animation-pressure.js";
import { registerMutationRenderers } from "./src/renderer.js";

import { compactMutationDetails } from "./src/persisted-result.js";
import type { FileMutationBatchResult } from "pi-agent-text-editor/api/mutation-result";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerTextEditorRenderer(pi: ExtensionAPI): Promise<void> {
  const animationPressure = createMutationAnimationPressure(pi);
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "text-editor-renderer",
    setup(api) {
      const tools = new Set<string>();
      api.onMutationTool(({ name }) => tools.add(name));
      registerMutationRenderers(api, animationPressure);
      pi.on("tool_result", (event) => {
        if (
          !tools.has(event.toolName) ||
          typeof event.details !== "object" ||
          event.details === null
        )
          return;
        const details = event.details as FileMutationBatchResult;
        if (!Array.isArray(details.results)) return;
        return { details: compactMutationDetails(details) };
      });
    },
  } satisfies TextEditorPlugin;

  await connectTextEditorPlugin(pi, plugin);
}
