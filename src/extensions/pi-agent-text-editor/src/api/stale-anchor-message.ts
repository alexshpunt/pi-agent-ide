import { quoteAnchorExcerpt } from "./anchor-excerpt.ts";

export interface StaleAnchorMessageDetails {
  readonly guardId: "stale-anchor";
  readonly effect: "not-applied";
  readonly toolName: string;
  readonly field: string;
  readonly path: string;
  readonly anchor: string;
  readonly context?: string;
  /** The guard interrupted argument streaming before the full call was received. */
  readonly stoppedEarly?: true;
}

export function formatStaleAnchorMessage(
  details: StaleAnchorMessageDetails,
  reason: string,
): string {
  const context = details.context === undefined ? "" : `\n\n${details.context}`;
  const guidance =
    details.context === undefined
      ? `Reread only the relevant section of "${details.path}" and use its current anchors.`
      : `If the required line is represented by one of the context lines below, use that anchor. Otherwise, reread only the relevant section of "${details.path}" and regenerate the anchor.`;
  const earlyStop = details.stoppedEarly
    ? "The guard intentionally stopped this call during streaming, before the full arguments or payload arrived. Missing text is a consequence of that stop, not a missing-payload mistake. Retrying the same stale selector will be refused again. "
    : "";
  return (
    `[SYSTEM] ${details.toolName} blocked: ${details.field === "anchor" ? "anchor" : `${details.field} anchor`} ${quoteAnchorExcerpt(details.anchor)} is stale. ` +
    `${earlyStop}${guidance} (${reason})${context}`
  );
}
