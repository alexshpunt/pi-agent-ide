import { wholeLineSelection, type LineSelection } from "./edit-equivalence.ts";
import { resultText, type RunEvent } from "./validation.ts";

/** A displayed line may include its text and one terminal separator, but must have been issued. */
export function issuedAnchor(value: unknown, output: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^([0-9A-HJKMNP-TV-Z]{7})(?:\|([^\r\n]*)(?:\r?\n)?)?$/u.exec(value);
  if (!match) return undefined;
  const hash = match[1];
  return output
    .split(/\r?\n/u)
    .some((line) =>
      match[2] === undefined ? line.startsWith(`${hash}|`) : line === `${hash}|${match[2]}`,
    )
    ? hash
    : undefined;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function ids(value: unknown): string[] {
  if (typeof value === "string") return [value];
  const id = record(value).id;
  return typeof id === "string" ? [id] : [];
}
function names(value: unknown, expected: unknown): boolean {
  return ids(value).some((id) =>
    ids(expected).some((own) => id.replace(/^RESULT#/u, "") === own.replace(/^RESULT#/u, "")),
  );
}
export function searchValue(end: RunEvent): Record<string, unknown> {
  const value = record(end.result?.structuredContent);
  return Array.isArray(value.matches) ? value : record(value.data);
}
/** Search match references identify their owning file even when the query has several sources. */
export function searchSources(value: unknown, end: RunEvent): string[] | undefined {
  const data = searchValue(end);
  if (!Array.isArray(data.matches)) return undefined;
  const reference = ids(value)[0];
  const direct = reference && /^SEARCH#[A-F0-9]+:(\d+):(line|match)$/u.exec(reference);
  const selected = data.matches.filter((entry, index) => {
    const match = record(entry);
    const refs = record(match.references);
    return (
      names(value, match.id ?? match.target) ||
      (reference !== undefined && (reference === refs.line || reference === refs.match)) ||
      (direct && Number(direct[1]) === index + 1 && resultText(end).includes(reference))
    );
  });
  if (!selected.length) return undefined;
  return selected.flatMap((entry) => {
    const match = record(entry);
    const path = match.path ?? match.source;
    return typeof path === "string" ? [path] : [];
  });
}
/** Keep whole-result authority distinct from an individual match in a larger selection. */
export function wholeSearchSelection(value: unknown, end: RunEvent): boolean {
  const data = searchValue(end);
  const own = record(end.result?.structuredContent).id;
  const envelope = /<uuid>([a-f0-9-]+)<\/uuid>/iu.exec(resultText(end))?.[1];
  return (
    names(value, own) ||
    names(value, data.target) ||
    names(value, envelope) ||
    ids(value).some(
      (id) => /^SEARCH#[A-F0-9]+:all:match$/u.test(id) && resultText(end).includes(id),
    ) ||
    singleSearchMatch(value, end)
  );
}
/** Only a complete, single-match Search makes its individual match the whole result. */
export function singleSearchMatch(value: unknown, end: RunEvent): boolean {
  const data = searchValue(end);
  if (data.complete !== true || !Array.isArray(data.matches) || data.matches.length !== 1)
    return false;
  const match = record(data.matches[0]);
  if (names(value, match.id ?? match.target)) return true;
  const references = record(match.references);
  return ids(value).some(
    (id) =>
      id === references.match ||
      (/^SEARCH#[A-F0-9]+:1:match$/u.test(id) && resultText(end).includes(id)),
  );
}

export interface SelectionIssuer {
  tool: string;
  args: Record<string, unknown>;
  end: RunEvent;
}
/** An exact string without an end selects a whole line when it is the complete line. */
export function exactSelection(
  content: string,
  value: unknown,
  paired: boolean,
): LineSelection | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (!paired) {
    const whole = wholeLineSelection(content, value);
    if (whole) return whole;
  }
  const from = content.indexOf(value);
  return from < 0 || content.indexOf(value, from + 1) >= 0
    ? undefined
    : { content, from, to: from + value.length };
}
/** Resolve only public issued selectors against unchanged fixture bytes, never by guessed hashes. */
export function issuedSelection(
  content: string,
  value: unknown,
  issuers: SelectionIssuer[],
  sameFile: (source: unknown) => boolean,
): LineSelection | undefined {
  const lines = [0, ...[...content.matchAll(/\n/gu)].map((match) => match.index + 1)].filter(
    (from) => from < content.length,
  );
  for (const issuer of issuers) {
    const output = resultText(issuer.end);
    if (issuer.tool === "read" || issuer.tool === "demo_read") {
      // A combined Read does not identify which source owns each displayed line or window.
      if (Array.isArray(issuer.args.path) && issuer.args.path.length !== 1) continue;
      const views = issuer.args.views;
      if (Array.isArray(views) && views.some((view) => view !== "anchors")) continue;
      const hash = issuedAnchor(value, output);
      if (hash) {
        const line = output.split(/\r?\n/u).find((line) => line.startsWith(`${hash}|`));
        const selected = wholeLineSelection(content, line?.slice(8));
        if (selected) return selected;
      }
      const own = record(issuer.end.result?.structuredContent).id;
      const envelope = /<uuid>([a-f0-9-]+)<\/uuid>/iu.exec(output)?.[1];
      if (!names(value, own) && !names(value, envelope)) continue;
      const offset = issuer.args.offset ?? 1;
      const limit = issuer.args.limit;
      if (
        typeof offset !== "number" ||
        !Number.isInteger(offset) ||
        offset < 1 ||
        (limit !== undefined &&
          (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1))
      )
        continue;
      const from = lines[offset - 1];
      if (from === undefined) continue;
      return {
        content,
        from,
        to:
          typeof limit === "number"
            ? (lines[offset - 1 + limit] ?? content.length)
            : content.length,
      };
    }
    if (issuer.tool !== "search") continue;
    const data = searchValue(issuer.end);
    if (!Array.isArray(data.matches)) continue;
    for (const [index, entry] of data.matches.entries()) {
      const match = record(entry);
      if (!sameFile(match.path ?? match.source)) continue;
      const references = record(match.references);
      const reference = ids(value)[0];
      const direct = reference && /^SEARCH#[A-F0-9]+:(\d+):(line|match)$/u.exec(reference);
      const issued = direct && Number(direct[1]) === index + 1 && output.includes(reference);
      const whole =
        names(value, data.id ?? data.target) && data.complete === true && data.matches.length === 1;
      if (
        !(
          issued ||
          whole ||
          names(value, match.id ?? match.target) ||
          (reference !== undefined &&
            (reference === references.line || reference === references.match))
        )
      )
        continue;
      const range = record(match.range);
      const number = match.line ?? range.startLine;
      const text = match.text ?? match.matchedText;
      if (
        typeof number !== "number" ||
        typeof text !== "string" ||
        typeof match.lineText !== "string"
      )
        continue;
      const from = lines[number - 1];
      if (from === undefined) continue;
      const to = lines[number] ?? content.length;
      const line = content.slice(from, to).replace(/\r?\n$/u, "");
      if (line !== match.lineText) continue;
      const lineReference = (issued && direct[2] === "line") || reference === references.line;
      if (lineReference) return { content, from, to };
      const column = range.startColumn;
      const local = typeof column === "number" ? column : line.indexOf(text);
      if (
        local < 0 ||
        line.slice(local, local + text.length) !== text ||
        (column === undefined && line.indexOf(text, local + 1) >= 0)
      )
        continue;
      return { content, from: from + local, to: from + local + text.length };
    }
  }
  return undefined;
}
