import {
    connectSearchPlugin,
    SEARCH_API_VERSION,
    SEARCH_PROTOCOL,
    type SearchPlugin,
} from "pi-agent-ide/api/search";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** External plugin fixture proving that plugins can connect to the unified IDE. */
export default function registerExternalSearchPlugin(pi: ExtensionAPI): void | Promise<void>
{
    const plugin = {
        protocol: SEARCH_PROTOCOL,
        apiVersion: SEARCH_API_VERSION,
        id: "external-integration-test",
        setup(api): void
        {
            api.addResolver({
                resolver: {
                    id: "external-integration-test",
                    tryResolve(request)
                    {
                        return request.query === "external:test"
                            ? { kind: "resolved", payload: "External plugin connected." }
                            : { kind: "not-handled" };
                    },
                    format(payload)
                    {
                        return { content: [{ type: "text", text: String(payload) }], details: {} };
                    },
                },
            });
        },
    } satisfies SearchPlugin;

    return connectSearchPlugin(pi, plugin);
}
