import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
    TEXT_EDITOR_API_VERSION,
    TEXT_EDITOR_PROTOCOL,
    TEXT_SEARCH_ANCHOR_KIND,
} from "pi-agent-text-editor/api/plugin-protocol";

import { createFileResolver, createRegexResolver, createTextResolver } from "#src/resolvers.js";
import { SearchSessionStore } from "#src/search-session.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerTextSearch(pi: ExtensionAPI): Promise<void>
{
    const sessions = new SearchSessionStore();
    await Promise.all([
        connectSearchPlugin(pi, {
            protocol: SEARCH_PROTOCOL,
            apiVersion: SEARCH_API_VERSION,
            id: "local",
            setup(api): void
            {
                api.addResolver({ resolver: createRegexResolver(sessions), priority: -10 });
                api.addResolver({ resolver: createFileResolver(), priority: -10 });
                api.addResolver({ resolver: createTextResolver(sessions), priority: 100 });
                api.describe([
                    "Searches workspace text and paths.",
                    "Use a plain query for literal text, `regex:<pattern>` for a regular expression, or `files:<pattern>` for file paths.",
                    "Text and regex results register stale-safe `SEARCH#...` anchors for text editor operations.",
                ].join("\n"));
            },
        }),
        connectTextEditorPlugin(pi, {
            protocol: TEXT_EDITOR_PROTOCOL,
            apiVersion: TEXT_EDITOR_API_VERSION,
            id: "search-anchors",
            setup(api): void
            {
                api.addAnchorResolver({
                    resolver: sessions.anchorResolver(),
                    resources: sessions.resourceResolver(),
                    kind: TEXT_SEARCH_ANCHOR_KIND,
                    type: "auxiliary",
                });
            },
        }),
    ]);
}

export { createSearchSessionId } from "#src/search-session.js";

export type { TextSearchMatch } from "#src/search-session.js";
