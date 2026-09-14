import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_POSITION_ANCHOR_KIND,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { createExactTextAnchorResolver } from "./src/anchor.js";
import { parseExactTextRecoveryConfig } from "./src/config.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Registers unique exact text as the final position-anchor fallback. */
export default async function registerExactTextAnchor(pi: ExtensionAPI): Promise<void> {
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "text-anchor-exact",
    setup(api) {
      api.addAnchorResolver({
        resolver: createExactTextAnchorResolver(
          parseExactTextRecoveryConfig(api.recoveryConfig("exactText")),
        ),
        kind: TEXT_POSITION_ANCHOR_KIND,
        type: "auxiliary",
        describeInPrompt: false,
        priority: 10_000,
      });
    },
  } satisfies TextEditorPlugin;

  await connectTextEditorPlugin(pi, plugin);
}
