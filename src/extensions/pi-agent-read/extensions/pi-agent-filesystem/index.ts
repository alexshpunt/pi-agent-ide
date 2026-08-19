import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL, type ReadPlugin } from "pi-agent-read/api/plugin-protocol";
import { createReadResultRenderer } from "pi-agent-read/api/rendering";
import { type ContentTarget, createContentHost, renderContentDescription } from "pi-agent-resource";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
    TEXT_EDITOR_API_VERSION,
    TEXT_EDITOR_PROTOCOL,
    type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { createFilesystemReadResolver, createFilesystemWriteResolver } from "#src/resolver.js";

const readTarget = { provider: "filesystem", capability: "read" } satisfies ContentTarget;
const writeTarget = { provider: "filesystem", capability: "write" } satisfies ContentTarget;
const renderReadResult = createReadResultRenderer({ kind: "source" });

export default async function registerFilesystemPlugin(pi: ExtensionAPI): Promise<void>
{
    const readHost = createContentHost(pi, readTarget);
    const writeHost = createContentHost(pi, writeTarget);
    const readResolver = createFilesystemReadResolver(readHost);
    const writeResolver = createFilesystemWriteResolver(writeHost);
    const readPlugin = {
        protocol: READ_PROTOCOL,
        apiVersion: READ_API_VERSION,
        id: "filesystem",
        setup(api)
        {
            api.addResolver({ resolver: readResolver, renderResult: renderReadResult });
            api.describe(() =>
                renderContentDescription(
                    "Reads local filesystem paths and file:// URLs. Directories are read-only listings.",
                    readHost.listDescriptions(),
                )
            );
        },
    } satisfies ReadPlugin;
    const textEditorPlugin = {
        protocol: TEXT_EDITOR_PROTOCOL,
        apiVersion: TEXT_EDITOR_API_VERSION,
        id: "filesystem",
        setup(api)
        {
            api.addResolver({ resolver: writeResolver });
            api.describe(() =>
                renderContentDescription(
                    "Writes local filesystem paths.",
                    writeHost.listDescriptions(),
                )
            );
        },
    } satisfies TextEditorPlugin;

    await Promise.all([
        connectReadPlugin(pi, readPlugin),
        connectTextEditorPlugin(pi, textEditorPlugin),
    ]);
}
