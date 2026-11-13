/** The system-result envelope that starts a readable result; its group is the result's UUID. */
export const envelopePattern =
  /^<system-result\b[^>]*><uuid>([a-f\d-]{36})<\/uuid><\/system-result>\n?/u;

/** `RESULT#<uuid>` for text that starts with a system-result envelope. */
export function resultReference(value: string): string | undefined {
  const uuid = envelopePattern.exec(value)?.[1];
  return uuid === undefined ? undefined : `RESULT#${uuid}`;
}
