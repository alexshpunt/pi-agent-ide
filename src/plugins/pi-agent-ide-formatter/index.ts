import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdePlugin } from "pi-agent-ide/api/plugin-protocol";

import { createFormatter } from "./src/formatter.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IdeTool } from "pi-agent-ide/api/toolchain";

export default function registerFormatter(pi: ExtensionAPI): void | Promise<void>
{
    const formatter = {
        kind: "formatter",
        name: "pi-agent-ide-formatter",
        priority: 200,
        extensions: ["*"],
        detect: () => Promise.resolve(true),
        async format(input, context)
        {
            return createFormatter().format(input, context);
        },
    } satisfies IdeTool;
    const plugin = {
        protocol: IDE_PROTOCOL,
        apiVersion: IDE_API_VERSION,
        id: "formatter",
        setup(api): void
        {
            api.addTool(formatter);
        },
    } satisfies IdePlugin;

    return connectIdePlugin(pi, plugin);
}
