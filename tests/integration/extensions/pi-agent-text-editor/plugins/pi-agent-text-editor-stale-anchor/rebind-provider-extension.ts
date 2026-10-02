import { appendFileSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REBOUND_PROVIDER_LOG = "rebound-provider.log";

/** Rebinds on conversation messages without treating transcript checkpoints as another message. */
export default function rebindProviderBetweenMessages(pi: ExtensionAPI): void {
  pi.on("message_end", (event, context_) => {
    // System checkpoints must not add another conversational provider wrapper.
    if (event.message.role === "system") return;
    const model = context_.model;

    if (!model) {
      return;
    }

    const provider = context_.modelRegistry.getProvider(model.provider);
    const config = context_.modelRegistry.getRegisteredProviderConfig(model.provider);

    if (!provider) {
      return;
    }

    const delegate = provider.streamSimple.bind(provider);
    pi.registerProvider(model.provider, {
      ...config,
      streamSimple(currentModel, context, options) {
        appendFileSync(path.join(context_.cwd, REBOUND_PROVIDER_LOG), "called\n", "utf8");
        return delegate(currentModel, context, options);
      },
    });
  });
}
