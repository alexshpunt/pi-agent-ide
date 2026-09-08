import type { ContentDescription } from "./content-converter.js";

export function renderContentDescription(
  summary: string,
  descriptions: readonly ContentDescription[],
): string | undefined {
  if (descriptions.length === 0) {
    return undefined;
  }

  const normalizedSummary = summary.trim();

  if (normalizedSummary.length === 0 || /[\r\n]/u.test(normalizedSummary)) {
    throw new TypeError("Content provider summary must be one non-empty line");
  }

  return [normalizedSummary, ...descriptions.map(({ description }) => description)].join("\n");
}
