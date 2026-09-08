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

  pi.on("tool_result", async (event, ctx) => {
    if (
      event.toolName !== "replace" ||
      event.isError ||
      typeof event.details !== "object" ||
      event.details === null
    )
      return;
    const observations = await sessions.observeAfterEdit(
      [event.input.path, event.input.start, event.input.end],
      ctx.signal,
    );
    if (observations.length === 0) return;
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: [
            "Original search observed after editing (not task validation):",
            ...observations.map((observation) => {
              const { query: _compiledQuery, fallbacks: _fallbacks, ...scope } = observation.scope;
              return [
                `SEARCH#${observation.sessionId}: ${JSON.stringify(observation.query)}`,
                `Scope and options: ${JSON.stringify(scope)}`,
                observation.error === undefined
                  ? `Matches: ${observation.matches}${observation.complete === true ? "; complete search." : "+; incomplete search, lower bound only."}`
                  : `Search failed: ${observation.error}. Applied edits remain applied.`,
                ...(observation.notices ?? []),
              ].join("\n");
            }),
          ].join("\n"),
        },
      ],
      details: { ...event.details, searchObservations: observations },
    };
  });

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
            "Local queries try literal terms first, then unquoted terms as regex when no literal results exist, then separate words for ordinary multi-word queries. Quoted terms stay literal. Boolean conditions stay intact across fallback. Uppercase AND/OR, infix NOT, ||, and space-separated | are Boolean operators; unspaced | and regex groups/classes belong to regex terms. Parentheses containing Boolean operators group Boolean conditions. regex:<pattern> forces regex-only matching; files:<pattern> searches file paths: glob patterns use *, **, ?, character classes and braces; other queries use case-insensitive subsequence matching. Slash-containing globs match cwd-relative paths; basename globs match at any depth.",
            "The result says when a query was broadened. Empty or unknown prefixes are searched as plain text. A recognized prefixed query returns its own results or error; it does not silently become a text search.",
            "SEARCH#HASH:N:line selects one containing line; :match selects its exact match. :all:line selects all unique containing lines and :all:match selects all matches. Read returns containing lines for both forms. A SEARCH resource can be used as a read path or mutation path/anchor; omit the file path for an all-selection spanning files.",
            "Use SEARCH references exactly as returned to select the matching content. A single-result reference becomes stale when its file changes; obtain a fresh result before using it again. An :all reference refreshes the original query when a selected file changes. Limited or incomplete searches do not provide :all selections.",
          ].join("\n"),
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
