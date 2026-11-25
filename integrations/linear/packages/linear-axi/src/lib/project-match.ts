import { asRecord } from "#axi/types.ts";
import { valueText } from "./value-text.ts";

export function projectMatches(
  input: unknown,
  value: string,
  options: { normalizeIdentifiers?: boolean } = {},
): boolean {
  const project = asRecord(input);
  if (!project) return false;
  const normalizedValue = normalizeText(value);
  const identifierMatches = options.normalizeIdentifiers
    ? normalizeText(project.id) === normalizedValue ||
      normalizeText(project.slugId) === normalizedValue
    : project.id === value || project.slugId === value;
  let slug: string | undefined;
  try {
    if (typeof project.url === "string") {
      const url = new URL(project.url);
      if (url.protocol === "https:" && url.hostname === "linear.app") {
        slug = /^\/[^/]+\/project\/([^/]+)(?:\/overview)?\/?$/u.exec(url.pathname)?.[1];
      }
    }
  } catch {
    /* A missing or invalid URL provides no extra identity. */
  }
  return (
    identifierMatches ||
    project.uuid === value ||
    normalizeText(project.name) === normalizedValue ||
    slug === value ||
    (/^[0-9a-f]{12}$/iu.test(value) && Boolean(slug?.endsWith(`-${value}`)))
  );
}

function normalizeText(value: unknown): string {
  return valueText(value ?? "")
    .trim()
    .toLocaleLowerCase();
}
