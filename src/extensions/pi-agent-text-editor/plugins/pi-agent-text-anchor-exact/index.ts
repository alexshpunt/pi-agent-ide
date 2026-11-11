import path from "node:path";
import { isLineAnchor } from "pi-agent-text";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_SEARCH_ANCHOR_KIND,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";
import { createExactTextAnchorResolver } from "./src/anchor.ts";
import { parseExactTextRecoveryConfig } from "./src/config.ts";
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
        (isLineAnchor(value) ||
          /^(?:RESULT#|SEARCH#|CHANGE#|scope-(?:begin|end)-|begin$|end$|<system-result)/iu.test(
            value,
          )),
    );
  });
}

/** Register exact text and require an issued selector after an explicit-text failure. */
export default async function registerExactTextAnchor(pi: ExtensionAPI): Promise<void> {
  const blocked = new Set<string>();
  const pendingRecovery = new Set<string>();
  // Exact text of Codemode calls accepted into a pending batch. A later failure blocks new exact
  // text, but the batch still resolves these values again when it is planned on the current text.
  const accepted = new Map<string, Set<string>>();
  const key = (source: string, cwd: string) => path.resolve(cwd, source);
  const clear = () => {
    blocked.clear();
    pendingRecovery.clear();
    accepted.clear();
  };
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);
  pi.on("agent_end", () => {
    pendingRecovery.clear();
    accepted.clear();
  });
  pi.on("tool_result", (event, context) => {
    const details = event.details as RecoveryDetails | undefined;
    if (!event.isError && details?.nativeEditBatch?.state === "accepted" && details.source) {
      const input: Record<string, unknown> = event.input;
      const target = typeof input.target === "string" ? input.target : details.source;
      for (const [field, source] of [
        ["start", details.source],
        ["end", details.source],
        ["anchor", details.source],
        ["targetStart", target],
        ["targetEnd", target],
      ] as const) {
        const value = input[field];
        if (typeof value !== "string") continue;
        const values = accepted.get(key(source, context.cwd)) ?? new Set<string>();
        values.add(value);
        accepted.set(key(source, context.cwd), values);
      }
    }
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
        accepted.delete(source);
        if (pendingRecovery.delete(source)) blocked.delete(source);
      });
      api.addAnchorResolver({
        resolver: createExactTextAnchorResolver(
          parseExactTextRecoveryConfig(api.recoveryConfig("exactText")),
          (source, cwd, value) =>
            blocked.has(key(source, cwd)) && !accepted.get(key(source, cwd))?.has(value),
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
