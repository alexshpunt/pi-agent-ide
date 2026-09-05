import {
  connectTipProvider,
  TIP_API_VERSION,
  TIP_PROTOCOL,
  type TipProvider,
} from "pi-agent-ide/api/tips";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deterministic provider used by the startup-tip integration contract. */
const provider = {
  protocol: TIP_PROTOCOL,
  apiVersion: TIP_API_VERSION,
  id: "qa-startup-tip",
  async getTip() {
    return {
      id: "qa-startup-tip-v1",
      title: "QA startup tip",
      body: "Use the project tools to inspect and edit code safely.",
    };
  },
} satisfies TipProvider;

/** Registers the deterministic provider with the Pi Agent IDE tip core. */
export default function registerTipProvider(pi: ExtensionAPI): void | Promise<void> {
  return connectTipProvider(pi, provider);
}
