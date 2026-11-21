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
      ? `No candidates to show. Use Read or Search in "${details.path}" to find a current anchor.`
      : "Use a current candidate only if it matches the intended line.";
  const earlyStop = details.stoppedEarly
    ? "The guard intentionally stopped this call during streaming, before the full arguments or payload arrived. Missing text is a consequence of that stop, not a missing-payload mistake. Retrying the same stale selector will be refused again. "
    : "";
  return (
    `[SYSTEM] ${details.toolName} blocked: ${details.field === "anchor" ? "anchor" : `${details.field} anchor`} ${quoteAnchorExcerpt(details.anchor)} is stale. ` +
    `${earlyStop}${guidance} (${reason})${context}`
  );
}
