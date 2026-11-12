import { readFile } from "node:fs/promises";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { connectResultTargets } from "pi-agent-resource";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPluginApi,
} from "pi-agent-read/api/plugin-protocol";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";
import type { SearchPluginApi } from "pi-agent-search/api/search";
import { registerFileSearchTool } from "#src/tool-file-search.ts";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_SEARCH_ANCHOR_KIND,
} from "pi-agent-text-editor/api/plugin-protocol";

import { textSearchDoctorPlugin } from "#src/doctor-plugin.ts";
import { createFileResolver, createRegexResolver, createTextResolver } from "#src/resolvers.ts";
import { SearchSessionStore } from "#src/search-session.ts";

import { compactSearchDetails } from "#src/persisted-result.ts";
import { isSearchToolDetails } from "#src/search-result.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerTextSearch(pi: ExtensionAPI): Promise<void> {
  return registerSearch(pi, true);
}

/** Reuse selection/anchor machinery without installing filesystem query resolvers. */
export async function registerResourceSearchSelections(pi: ExtensionAPI): Promise<void> {
  return registerSearch(pi, false);
}

async function registerSearch(pi: ExtensionAPI, includeFilesystem: boolean): Promise<void> {
  let resolveSearchApi!: (api: SearchPluginApi) => void;
  const searchApi = new Promise<SearchPluginApi>((resolve) => (resolveSearchApi = resolve));
  // Not registered with search: file_search runs it through the shared execution core.
  if (includeFilesystem) registerFileSearchTool(pi, createFileResolver(), searchApi);
  let read: ReadPluginApi | undefined;
  const sessions = new SearchSessionStore(
    undefined,
    connectResultTargets(pi),
    async (source, cwd, signal) => {
      if (read === undefined) {
        if (!includeFilesystem) throw new Error("Resource search requires its owning Read host.");
        // Standalone Search owns local files, but must never treat remote identities as paths.
        if (source.includes("://")) throw new Error("No search snapshot owner for this source.");
        return readFile(source, { encoding: "utf8", signal });
      }
      const result = await read.read({ path: source }, { cwd, signal }, "script");
      if (result.isError || result.script?.kind !== "text" || result.script.source !== source)
        throw new Error(
          result.details.failure?.message ?? "The source cannot provide an exact text snapshot.",
        );
      return result.script.content;
    },
  );

  pi.on("tool_result", async (event, ctx) => {
    if (
      event.toolName !== "replace" ||
      event.isError ||
      typeof event.details !== "object" ||
      event.details === null
    )
      return;
    const metadata = "metadata" in event.details ? event.details.metadata : undefined;
    const recorded =
      metadata && typeof metadata === "object" && "searchObservations" in metadata
        ? metadata.searchObservations
        : undefined;
    const observations = Array.isArray(recorded)
      ? (recorded as Awaited<ReturnType<SearchSessionStore["observeAfterEdit"]>>)
      : await sessions.observeAfterEdit(
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
      ...(event.structuredContent === undefined
        ? {}
        : { structuredContent: event.structuredContent }),
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
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: "search-snapshots",
      setup(api): void {
        read = api;
      },
    }),
    connectDoctorPlugin(pi, textSearchDoctorPlugin),
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "local",
      // The same store owns Read/edit selectors and Search input scopes.
      setup(api): void {
        api.addScopeProvider((value, context) => sessions.resolveSearchScope(value, context));
        api.addSelectionProvider((selection, context) =>
          sessions.register(
            selection.request.query,
            selection.matches,
            selection.complete,
            context.cwd,
            context.signal,
            { ...selection.request, regex: false },
            selection.refresh,
            undefined,
            context.environment,
            // A backend that returns the text it searched needs no second read, which another
            // session could write in between.
            selection.contents,
          ),
        );
        if (includeFilesystem) {
          resolveSearchApi(api);
          api.addResolver({ resolver: createRegexResolver(sessions), priority: -10 });
          api.addResolver({ resolver: createTextResolver(sessions), fallback: true });
        } else {
          api.addResolver({ resolver: createRegexResolver(sessions, true), priority: -10 });
          api.addResolver({ resolver: createTextResolver(sessions, true), fallback: true });
        }
      },
    }),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "search-anchors",
      setup(api): void {
        api.tool("replace").addHandler({
          stage: "text-post-edit",
          async handler(state) {
            if (
              !state.result ||
              typeof state.result !== "object" ||
              !("kind" in state.result) ||
              state.result.kind !== "completed" ||
              !state.input ||
              typeof state.input !== "object"
            )
              return state;
            const input = state.input as Record<string, unknown>;
            const observations = await sessions.observeAfterEdit(
              [input.path, input.start, input.end],
              state.signal,
            );
            return observations.length === 0
              ? state
              : { ...state, metadata: { ...state.metadata, searchObservations: observations } };
          },
        });
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

export { createSearchSessionId } from "#src/search-session.ts";

export type { TextSearchMatch } from "#src/search-session.ts";
