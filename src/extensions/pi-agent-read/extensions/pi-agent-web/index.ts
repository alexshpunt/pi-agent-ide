import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL, type ReadPlugin } from "pi-agent-read/api/plugin-protocol";
import { createReadResultRenderer } from "pi-agent-read/api/rendering";
import { type ContentTarget, createContentHost, renderContentDescription } from "pi-agent-resource";

import { createWebResolver } from "#src/resolver.js";

const readTarget = { provider: "web", capability: "read" } satisfies ContentTarget;
const renderReadResult = createReadResultRenderer({ kind: "markdown", label: "WEB" });

export default async function registerWeb(pi: ExtensionAPI): Promise<void>
{
    const readHost = createContentHost(pi, readTarget);
    const resolver = createWebResolver(readHost);
    const plugin = {
        protocol: READ_PROTOCOL,
        apiVersion: READ_API_VERSION,
        id: "web",
        setup(api)
        {
            api.addResolver({
                resolver,
                renderResult: renderReadResult,
                preserveTruncatedOutput: true,
            });
            api.describe(() =>
                renderContentDescription(
                    "Reads HTTP(S) URLs.",
                    readHost.listDescriptions(),
                )
            );
        },
    } satisfies ReadPlugin;

    await connectReadPlugin(pi, plugin);
}
