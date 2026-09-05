import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_SEARCH_ANCHOR_KIND,
} from "pi-agent-text-editor/api/plugin-protocol";

import { textSearchDoctorPlugin } from "#src/doctor-plugin.js";
import { createFileResolver, createRegexResolver, createTextResolver } from "#src/resolvers.js";
import { SearchSessionStore } from "#src/search-session.js";

import { compactSearchDetails } from "#src/persisted-result.js";
import { isSearchToolDetails } from "#src/search-result.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerTextSearch(pi: ExtensionAPI): Promise<void> {
  const sessions = new SearchSessionStore();

  pi.on("tool_result", (event) => {
    if (event.toolName !== "search" || typeof event.details !== "object" || event.details === null)
      return;
    const details = event.details as { payload?: unknown };
    if (!isSearchToolDetails(details.payload)) return;
    return {
      details: {
        ...details,
        payload: compactSearchDetails(
          details.payload,
          event.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
        ),
      },
    };
  });
  await Promise.all([
    connectDoctorPlugin(pi, textSearchDoctorPlugin),
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "local",
      setup(api): void {
        api.addResolver({ resolver: createRegexResolver(sessions), priority: -10 });
        api.addResolver({ resolver: createFileResolver(), priority: -10 });
        api.addResolver({ resolver: createTextResolver(sessions), fallback: true });
        api.describe(
          [
            "Searches workspace text and paths.",
            "Local queries try literal terms first, then unquoted terms as regex when no literal results exist, then separate words for ordinary multi-word queries. Quoted terms stay literal. Boolean conditions stay intact across fallback. Uppercase AND/OR, infix NOT, ||, and space-separated | are Boolean operators; unspaced | and regex groups/classes belong to regex terms. Parentheses containing Boolean operators group Boolean conditions. regex:<pattern> forces regex-only matching; files:<pattern> searches file paths.",
            "Complete text and regex result sessions register four stale-safe typed resources for read and text-editor operations: SEARCH#HASH:N:line, SEARCH#HASH:N:match, SEARCH#HASH:all:line, and SEARCH#HASH:all:match. Search IDs use four uppercase hexadecimal characters by default and grow only on collision. Limited or incomplete sessions omit the all-result resources.",
          ].join("\n"),
        );

        api.addPromptGuideline(
          "Local search tries literal terms first, then unquoted terms as regex if no matches exist, then separate words for ordinary multi-word queries. Search reports each fallback; invalid optional regex is skipped. Quoted and Boolean queries never fall back to separate words.",
        );
        api.addPromptGuideline(
          'You can combine search terms with uppercase `AND`/`OR`, infix `NOT`, `||`, or space-separated `|`. Parentheses containing Boolean operators group conditions. Regex groups, classes, and escapes stay inside terms: `(?:foo|bar)\\d+ AND "keep.me" NOT ignored`. Quoted terms stay literal, including during regex fallback; `foo|bar` first searches that exact text, then regex alternatives.',
        );
        api.addPromptGuideline(
          "You can use `regex:<pattern>` to force regex-only search and `files:<pattern>` for file paths. Empty or unhandled protocol queries fall back to searching the original text, including the prefix. Resolver errors, timeouts, and successful empty protocol results do not trigger text fallback.",
        );
        api.addPromptGuideline(
          "You can narrow local search with `path`, `include`, `exclude`, `caseSensitive`, `wholeWord`, and `limit`.",
        );
        api.addPromptGuideline(
          [
            "You can reuse complete text and regex search results through these `SEARCH#...` values:",
            "  - `SEARCH#HASH:N:line` selects one result's full line.",
            "  - `SEARCH#HASH:N:match` selects one exact match.",
            "  - `SEARCH#HASH:all:line` selects every unique containing line.",
            "  - `SEARCH#HASH:all:match` selects every exact match.",
            "  Read shows the containing lines for both modes; `:line` and `:match` control the edit range, not partial-line read rendering.",
            "  Limited or incomplete searches omit the `all` values.",
          ].join("\n"),
        );
        api.addPromptGuideline(
          "You can pass a returned `SEARCH#...` value directly to read or a compatible mutation tool as its path or anchor. Omit the file path when an `all` value spans files.",
        );
        api.addPromptGuideline(
          "You can replace every exact search match by passing `SEARCH#HASH:all:match` as the replace path, or replace whole matched lines with `SEARCH#HASH:all:line`.",
        );
      },
    }),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "search-anchors",
      setup(api): void {
        api.addAnchorResolver({
          resolver: sessions.anchorResolver(),
          resources: sessions.resourceResolver(),
          kind: TEXT_SEARCH_ANCHOR_KIND,
          type: "auxiliary",
          describeInPrompt: false,
        });
      },
    }),
  ]);
}

export { createSearchSessionId } from "#src/search-session.js";

export type { TextSearchMatch } from "#src/search-session.js";
