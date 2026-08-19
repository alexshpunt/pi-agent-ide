import { appendFileSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REBOUND_PROVIDER_LOG = "rebound-provider.log";

export default function rebindProviderBetweenMessages(pi: ExtensionAPI): void
{
    pi.on("message_end", (_event, ctx) =>
    {
        const model = ctx.model;

        if (!model)
        {
            return;
        }

        const provider = ctx.modelRegistry.getProvider(model.provider);
        const config = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);

        if (!provider)
        {
            return;
        }

        const delegate = provider.streamSimple.bind(provider);
        pi.registerProvider(model.provider, {
            ...config,
            streamSimple(currentModel, context, options)
            {
                appendFileSync(path.join(ctx.cwd, REBOUND_PROVIDER_LOG), "called\n", "utf8");
                return delegate(currentModel, context, options);
            },
        });
    });
}
