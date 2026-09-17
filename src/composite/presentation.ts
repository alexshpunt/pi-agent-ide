export type ToolPresentation = "full" | "compact" | "disabled";

/** Resolve a stored presentation choice with the compact product default. */
export function toolPresentation(value: string | undefined): ToolPresentation {
  return value === "full" || value === "disabled" ? value : "compact";
}

/** Expanded tools always show their full presentation. */
export function effectiveToolPresentation(
  preference: ToolPresentation,
  expanded: boolean,
): ToolPresentation {
  return expanded ? "full" : preference;
}
