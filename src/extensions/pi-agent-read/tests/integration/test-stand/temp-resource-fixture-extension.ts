import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL, type ReadPlugin } from "pi-agent-read/api/plugin-protocol";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const text = Array.from({ length: 2_001 }, (_, index) => `fixture line ${index + 1}`).join("\n");

export default async function registerTempResourceFixture(pi: ExtensionAPI): Promise<void>
{
    pi.on("tool_call", (event, context) =>
    {
        if (event.toolName !== "read" || (event.input as { path?: string; }).path !== "temp:fixture-latest")
        {
            return;
        }

        const latest = context.sessionManager.getBranch().findLast((entry) =>
        {
            if (entry.type !== "message" || entry.message.role !== "toolResult")
            {
                return false;
            }

            return typeof (entry.message.details as { temporarySource?: unknown; } | undefined)?.temporarySource
                === "string";
        });
        const temporarySource = latest?.type === "message" && latest.message.role === "toolResult"
            ? (latest.message.details as { temporarySource: string; }).temporarySource
            : undefined;

        if (temporarySource === undefined)
        {
            throw new Error("The fixture temporary resource was not created");
        }

        (event.input as { path: string; }).path = temporarySource;
    });
    const plugin = {
        protocol: READ_PROTOCOL,
        apiVersion: READ_API_VERSION,
        id: "temp-resource-fixture",
        setup(api): void
        {
            api.addResolver({
                preserveTruncatedOutput: true,
                resolver: {
                    id: "temp-resource-fixture",
                    // eslint-disable-next-line @typescript-eslint/require-await
                    async tryResolve(source)
                    {
                        if (source !== "dynamic:large-fixture")
                        {
                            return { kind: "not-handled" };
                        }

                        return {
                            kind: "resolved",
                            resource: {
                                source,
                                // eslint-disable-next-line @typescript-eslint/require-await
                                async read()
                                {
                                    return [{ type: "text", text }];
                                },
                            },
                        };
                    },
                },
            });
        },
    } satisfies ReadPlugin;

    await connectReadPlugin(pi, plugin);
}
