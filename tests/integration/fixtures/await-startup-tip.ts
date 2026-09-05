import { randomUUID } from "node:crypto";

import { waitForTip } from "#integration/support/wait-for-tip.ts";
import { connectTipProvider, TIP_API_VERSION, TIP_PROTOCOL } from "pi-agent-ide/api/tips";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Loaded last by tip-content tests. A fallback tip makes completion observable even
 * when every real tip is suppressed. Only these tests wait before their first turn.
 */
export default async function awaitStartupTip(pi: ExtensionAPI): Promise<void> {
  const registration = connectTipProvider(pi, {
    protocol: TIP_PROTOCOL, apiVersion: TIP_API_VERSION, id: "test-completion",
    getTip: () => ({ id: `completion-${randomUUID()}`, title: "Inspection finished", body: "Test completion marker" }),
  });
  await registration;
  pi.on("before_agent_start", async (_event, context) => {
    if (registration !== undefined) await waitForTip(context);
  });
}
