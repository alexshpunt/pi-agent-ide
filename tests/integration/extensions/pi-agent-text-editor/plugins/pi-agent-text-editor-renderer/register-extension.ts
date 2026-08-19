import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import registerConstantTextAnchors from "#pi-agent-text-anchor-constant/index.js";
import registerLineHashTextAnchor from "#pi-agent-text-anchor-line-hash/index.js";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#pi-agent-text-editor/api/plugin-protocol.js";
import { registerBuiltinEditFilter } from "#pi-agent-text-editor/core/builtin-edit-filter.js";
import registerTextEditorCore from "#pi-agent-text-editor/core/extension.js";
import { registerTextEditBatching } from "#pi-agent-text-editor/core/text-edit-batch-registrar.js";
import { registerTextEditorTools } from "#pi-agent-text-editor/tools/extension.js";
import registerTextEditorRenderer from "#pi-agent-text-editor-renderer/index.js";
import { createTextDocument } from "pi-agent-text";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerRendererTestStand(pi: ExtensionAPI): Promise<void>
{
    const core = await registerTextEditorCore(pi);

    core.registerPostEditHandler({
        id: "renderer-formatter-fixture",
        async handler(transaction)
        {
            if (path.basename(transaction.source) !== "post-edit-viewport.ts")
            {
                return;
            }

            const file = path.resolve(transaction.cwd, transaction.source);
            const content = await readFile(file, "utf8");
            const lines = content.split("\n");
            lines[0] = "// formatted outside generated viewport";
            lines[18] = "const value19 = formattedContext();";
            await writeFile(file, lines.join("\n"), "utf8");
        },
    });
    await core.registerPlugin({
        protocol: TEXT_EDITOR_PROTOCOL,
        apiVersion: TEXT_EDITOR_API_VERSION,
        id: "renderer-final-content-fixture",
        setup(api)
        {
            api.addTextPresenter({
                presenter: {
                    id: "renderer-final-content",
                    async present(document, context)
                    {
                        if (path.basename(context.source) !== "post-edit-viewport.ts")
                        {
                            return document;
                        }

                        const content = await readFile(path.resolve(context.cwd, context.source), "utf8");
                        return createTextDocument(document.source, content);
                    },
                },
            });
        },
    });
    await registerTextEditorRenderer(pi);
    registerTextEditorTools(pi, core);
    registerTextEditBatching(pi, core);
    registerBuiltinEditFilter(pi);
    await Promise.all([registerLineHashTextAnchor(pi), registerConstantTextAnchors(pi)]);
}
