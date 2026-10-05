import { Text } from "@earendil-works/pi-tui";
import { MutationPanel } from "./src/mutation-panel.js";
import { resolveMutationResultResources } from "./src/mutation-result.js";
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

function parsePresentation(value: string | undefined): "full" | "compact" | "disabled" {
  return value === "full" || value === "disabled" ? value : "compact";
}
export default async function registerTextEditorRenderer(
  pi: ExtensionAPI,
  context?: { readonly preferences: Readonly<Record<string, string>> },
): Promise<void> {
  const diffPresentation = parsePresentation(context?.preferences["ui.diffs"]);
  const animationPressure = createMutationAnimationPressure(pi);
  let animationsEnabled = pi.getFlag("pi-agent-ide-no-animations") !== true;
  const refreshAnimations = () => {
    animationsEnabled = pi.getFlag("pi-agent-ide-no-animations") !== true;
  };
  pi.on("session_start", refreshAnimations);
  pi.on("before_agent_start", refreshAnimations);
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "text-editor-renderer",
    setup(api) {
      api.addToolRenderer({
        tool: "diff",
        renderResult(result, options, theme, context) {
          const details = result.details as FileMutationBatchResult | undefined;
          if (context.isError || details?.results === undefined)
            return new Text(
              result.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n"),
              0,
              0,
            );
          const panel = new MutationPanel(theme);
          panel.setBackground("toolSuccessBg");
          const mode = options.expanded ? "full" : diffPresentation;
          panel.setExpanded(mode === "full");
          panel.setDiffsVisible(mode !== "disabled");
          panel.setResourceLabelsVisible(true);
          panel.setResultResources(resolveMutationResultResources(details, undefined));
          return panel;
        },
      });
      const tools = new Set<string>();
      api.onMutationTool(({ name }) => tools.add(name));
      registerMutationRenderers(
        api,
        animationPressure,
        // Completed panels can be redrawn after Pi has invalidated the extension API.
        () => animationsEnabled,
        diffPresentation,
      );
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
