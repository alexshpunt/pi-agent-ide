import {
    type AgentToolResult,
    type ExtensionAPI,
    keyText,
    type Theme,
    type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { ToolCallInterceptionRenderStore, withToolCallInterceptionRendering } from "pi-agent-tool-call-interception";
import { type Static, Type } from "typebox";

import {
    isSearchPluginRegistrationRequest,
    SEARCH_API_VERSION,
    SEARCH_CORE_READY_EVENT,
    SEARCH_PLUGIN_REGISTER_EVENT,
    SEARCH_PROTOCOL,
} from "#src/api/plugin-protocol.js";
import { createSearchCore } from "#src/core/search-core.js";

import type { SearchToolDetails } from "#src/api/search.js";

const searchSchema = Type.Object({
    query: Type.String({
        minLength: 1,
        description: "Search query. Installed prefixes select specialized search protocols.",
    }),
    path: Type.Optional(Type.String({ description: "Optional file or directory scope for local search" })),
    include: Type.Optional(Type.String({ description: "Optional include glob for local search" })),
    exclude: Type.Optional(Type.String({ description: "Optional exclude glob for local search" })),
    caseSensitive: Type.Optional(Type.Boolean({ description: "Match letter case in local search" })),
    wholeWord: Type.Optional(Type.Boolean({ description: "Match complete words in local search" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum results (default 100)" })),
}, { additionalProperties: false });

type SearchParams = Static<typeof searchSchema>;

export default async function registerSearchCore(pi: ExtensionAPI): Promise<void>
{
    const core = createSearchCore();
    const interceptionRendering = new ToolCallInterceptionRenderStore();
    const unsubscribe = pi.events.on(SEARCH_PLUGIN_REGISTER_EVENT, (request) =>
    {
        if (!isSearchPluginRegistrationRequest(request))
        {
            throw new Error("Invalid pi-agent-search plugin registration request");
        }

        request.accept(core.registerPlugin(request.plugin));
    });
    pi.on("session_shutdown", unsubscribe);
    pi.registerTool(withToolCallInterceptionRendering({
        name: "search",
        label: "search",
        description: "Search through installed local, semantic, web, language, and structural search protocols.",
        promptSnippet: "Search workspace text and paths and return reusable anchors for text edits",
        get promptGuidelines(): string[]
        {
            const pluginGuideline = core.renderPromptGuideline();
            return [
                "Use the narrowest useful search query and scope; broaden when needed.",
                "Do not use search to rediscover a file path already named in the request; use that path directly and search only if access fails.",
                "When exact text that may need editing is already known, use search directly instead of repeating the lookup with grep or find; search returns reusable anchors.",
                "When every exact search match needs the same replacement, pass the returned SEARCH#HASH:all anchor to replace.",
                ...(pluginGuideline === undefined ? [] : [pluginGuideline]),
            ];
        },
        parameters: searchSchema,
        renderShell: "self",
        renderCall(args, theme): Component
        {
            const query = typeof args.query === "string" ? args.query : "";
            const scope = typeof args.path === "string" ? ` ${theme.fg("dim", args.path)}` : "";
            return new Text(
                `${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("accent", JSON.stringify(query))}${scope}`,
                0,
                0,
            );
        },
        renderResult(result, options, theme, context): Component
        {
            const details = result.details as SearchToolDetails | undefined;
            const renderer = details?.resolverId === undefined ? undefined : core.renderer(details.resolverId);

            if (renderer !== undefined)
            {
                const inner = { ...result, details: details?.payload };
                return renderer(inner, options, theme, context);
            }

            return fallbackResult(result, options, theme);
        },
        async execute(_id, params: SearchParams, signal, onUpdate, context): Promise<AgentToolResult<SearchToolDetails>>
        {
            await core.waitForPendingPlugins();
            return core.execute(params, {
                cwd: context.cwd,
                ...(signal === undefined ? {} : { signal }),
                ...(onUpdate === undefined
                    ? {}
                    : {
                        onUpdate: (update) =>
                        {
                            onUpdate(update);
                        },
                    }),
            });
        },
    }, interceptionRendering));
    pi.events.emit(SEARCH_CORE_READY_EVENT, { protocol: SEARCH_PROTOCOL, apiVersion: SEARCH_API_VERSION });
    await core.waitForPendingPlugins();
}

function fallbackResult(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
): Component
{
    const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    const preview = options.expanded ? text : text.split("\n").slice(0, 8).join("\n");
    const hint = !options.expanded && text.split("\n").length > 8
        ? `\n${theme.fg("dim", `${keyText("app.tools.expand")} to expand`)}`
        : "";
    return new Text(`${theme.fg("muted", preview)}${hint}`, 0, 0);
}
