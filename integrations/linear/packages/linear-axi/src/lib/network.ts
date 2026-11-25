import net from "node:net";

/**
 * Per-address TCP connect budget for Node's happy-eyeballs (`autoSelectFamily`).
 * Node's default of 250 ms counts event-loop delay too, so on a loaded machine or a slow
 * link every address attempt can expire and fetch fails with ETIMEDOUT although Linear
 * is reachable. mcp.linear.app has four addresses; 4 × 2 s stays within undici's 10 s
 * connect timeout.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2000;

/** Raise the process-wide attempt budget; a larger value set with Node's flag is kept. */
export function configureNetwork(): void {
  if (net.getDefaultAutoSelectFamilyAttemptTimeout() < CONNECT_ATTEMPT_TIMEOUT_MS)
    net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
}
