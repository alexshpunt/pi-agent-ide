import path from "node:path";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_SEARCH_ANCHOR_KIND,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";
import { createExactTextAnchorResolver } from "./src/anchor.js";
import { parseExactTextRecoveryConfig } from "./src/config.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface RecoveryDetails {
  metadata?: { exactTextFailures?: string[] };
  source?: string;
  nativeEditBatch?: { state: string };
  results?: { data?: { ok?: boolean; path?: string } }[];
}

/** Recognize issued source/anchor syntax only after its tool has validated it. */
function usesRegisteredSelector(input: Record<string, unknown>): boolean {
  return [
    "path",
    "file",
    "target",
    "start",
    "end",
    "anchor",
    "targetStart",
    "targetEnd",
    "change",
  ].some((field) => {
    const value = input[field];
    const values: unknown[] = Array.isArray(value) ? value : [value];
    return values.some(
      (value: unknown) =>
        typeof value === "string" &&
        /^(?:RESULT#|SEARCH#|CHANGE#|scope-(?:begin|end)-|\d+#[a-f\d]+$|begin$|end$|<system-result)/iu.test(
          value,
        ),
    );
  });
}

/** Register exact text and require an issued selector after an explicit-text failure. */
export default async function registerExactTextAnchor(pi: ExtensionAPI): Promise<void> {
  const blocked = new Set<string>();
  const pendingRecovery = new Set<string>();
  const key = (source: string, cwd: string) => path.resolve(cwd, source);
  const clear = () => {
    blocked.clear();
    pendingRecovery.clear();
  };
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);
  pi.on("agent_end", () => pendingRecovery.clear());
  pi.on("tool_result", (event, context) => {
    const details = event.details as RecoveryDetails | undefined;
    for (const source of details?.metadata?.exactTextFailures ?? []) {
      blocked.add(key(source, context.cwd));
      pendingRecovery.delete(key(source, context.cwd));
    }
    if (event.isError || !usesRegisteredSelector(event.input)) return;
    if (details?.nativeEditBatch?.state === "accepted" && details.source) {
      const source = key(details.source, context.cwd);
      if (blocked.has(source)) pendingRecovery.add(source);
      return;
    }
    for (const result of details?.results ?? []) {
      if (result.data?.ok && result.data.path) blocked.delete(key(result.data.path, context.cwd));
    }
  });
  const plugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "text-anchor-exact",
    setup(api) {
      api.onDidEdit((completion) => {
        const source = key(completion.resourceSource, completion.cwd);
        if (pendingRecovery.delete(source)) blocked.delete(source);
      });
      api.addAnchorResolver({
        resolver: createExactTextAnchorResolver(
          parseExactTextRecoveryConfig(api.recoveryConfig("exactText")),
          (source, cwd) => blocked.has(key(source, cwd)),
        ),
        kind: TEXT_SEARCH_ANCHOR_KIND,
        type: "auxiliary",
        describeInPrompt: false,
        priority: 10_000,
      });
    },
  } satisfies TextEditorPlugin;
  await connectTextEditorPlugin(pi, plugin);
}
