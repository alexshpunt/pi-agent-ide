export interface StaleAnchorMessageDetails {
  readonly guardId: "stale-anchor";
  readonly effect: "not-applied";
  readonly toolName: string;
  readonly field: string;
  readonly path: string;
  readonly anchor: string;
  readonly context?: string;
}

export function formatStaleAnchorMessage(
  details: StaleAnchorMessageDetails,
  reason: string,
): string {
  const context = details.context === undefined ? "" : `\n\n${details.context}`;
  return (
    `[SYSTEM] ${details.toolName} blocked: ${details.field} anchor "${details.anchor}" is stale. ` +
    `If the required line is represented by one of the context lines below, use that anchor. Otherwise, reread only the relevant section of "${details.path}" and regenerate the anchor. (${reason})${context}`
  );
}
