import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
    TEXT_EDITOR_API_VERSION,
    TEXT_EDITOR_PROTOCOL,
    type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { registerArgumentOrderGuard } from "./src/argument-order-guard.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerTextEditorArgumentOrder(pi: ExtensionAPI): Promise<void>
{
    const plugin = {
        protocol: TEXT_EDITOR_PROTOCOL,
        apiVersion: TEXT_EDITOR_API_VERSION,
        id: "text-editor-argument-order",
        setup(api)
        {
            const addRegistration = registerArgumentOrderGuard(pi);
            api.onMutationTool((registration) =>
            {
                addRegistration({ name: registration.name, schema: registration.parameters });
            });
        },
    } satisfies TextEditorPlugin;

    await connectTextEditorPlugin(pi, plugin);
}
