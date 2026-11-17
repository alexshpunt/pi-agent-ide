import { wholeLineSelection, type LineSelection } from "./edit-equivalence.ts";
import { toolSemantics } from "./argument-equivalence.ts";
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
  if (!selected.length && wholeSearchSelection(value, end))
    selected.push(...(data.matches as unknown[]));
  if (!selected.length) return undefined;
  const sources = selected.flatMap((entry) => {
    const match = record(entry);
    const path = match.path ?? match.source;
    return typeof path === "string" ? [path] : [];
  });
  return sources.length ? sources : undefined;
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
/** Canonical numbered match issued by this Search, including native match-value aliases. */
export function searchMatchReference(value: unknown, end: RunEvent): string | undefined {
  const shown = [...resultText(end).matchAll(/SEARCH#[A-F0-9]+:\d+:match\b/gu)].map(
    (match) => match[0],
  );
  const data = searchValue(end);
  const matches = Array.isArray(data.matches) ? data.matches : [];
  for (const [index, entry] of matches.entries()) {
    const match = record(entry);
    const reference =
      record(match.references).match ??
      shown.find((ref) => ref.split(":")[1] === String(index + 1));
    if (typeof reference !== "string") continue;
    if (names(value, match.id ?? match.target) || names(value, reference)) return reference;
  }
  return ids(value).find((id) => shown.includes(id));
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

/** Compare inline fragments using a Search line snapshot; callers must establish freshness. */
export function issuedSearchFragment(
  exact: string,
  value: unknown,
  paired: boolean,
  issuers: SelectionIssuer[],
  sameFile: (source: unknown) => boolean,
): boolean {
  for (const issuer of issuers) {
    if (issuer.tool !== "search") continue;
    const data = searchValue(issuer.end);
    if (!Array.isArray(data.matches)) continue;
    for (const [index, entry] of data.matches.entries()) {
      const match = record(entry);
      const range = record(match.range);
      const line = match.line ?? range.startLine;
      const content = match.lineText;
      if (
        !sameFile(match.path ?? match.source) ||
        typeof content !== "string" ||
        typeof line !== "number" ||
        !Number.isInteger(line) ||
        line < 1 ||
        (range.startLine !== undefined && range.startLine !== line) ||
        (!paired && wholeLineSelection(content, exact))
      )
        continue;
      // A line snapshot omits its final separator, so it cannot prove whole-line ownership.
      const required = exactSelection(content, exact, paired);
      if (!required) continue;
      const local = {
        ...match,
        line: 1,
        range: {
          ...range,
          startLine: 1,
          endLine: typeof range.endLine === "number" ? range.endLine - line + 1 : range.endLine,
        },
      };
      const snapshot: SelectionIssuer = {
        ...issuer,
        end: {
          ...issuer.end,
          result: {
            ...issuer.end.result,
            structuredContent: {
              ...record(issuer.end.result?.structuredContent),
              ...data,
              // Keep indices and cardinality: one selected match cannot become the whole result.
              matches: data.matches.map((_, position) => (position === index ? local : null)),
            },
          },
        },
      };
      const selected = issuedSelection(content, value, [snapshot], sameFile);
      if (selected && required.from === selected.from && required.to === selected.to) return true;
    }
  }
  return false;
}
export interface SelectionIssuer {
  tool: string;
  args: Record<string, unknown>;
  end: RunEvent;
}
/** Multi-Read values and direct section headers both preserve request order and source ownership. */
export function readSourceIssuers(
  issuer: SelectionIssuer,
  sourceMatches: (source: unknown, header: string) => boolean = (source, header) =>
    source === header,
): SelectionIssuer[] {
  if (toolSemantics(issuer.tool) !== "read" || !Array.isArray(issuer.args.path)) return [issuer];
  const paths: unknown[] = issuer.args.path;
  const items: unknown = issuer.end.result?.structuredContent;
  if (Array.isArray(items)) {
    if (items.length !== paths.length) return [];
    const references = items.flatMap((item) => ids(item).map((id) => id.replace(/^RESULT#/u, "")));
    if (new Set(references).size !== references.length) return [];
    return items.map((item: unknown, index: number) => {
      const value = record(item);
      const valid = typeof value.id === "string" && typeof value.text === "string";
      return {
        ...issuer,
        args: { ...issuer.args, path: paths[index] },
        end: {
          ...issuer.end,
          // Empty siblings keep their slot without issuing selection authority.
          result: valid
            ? {
                content: [{ type: "text", text: value.text as string }],
                structuredContent: item,
              }
            : {},
        },
      };
    });
  }
  if (paths.length === 1) return [{ ...issuer, args: { ...issuer.args, path: paths[0] } }];
  if (!paths.length) return [];
  const output = resultText(issuer.end);
  const headers = [...output.matchAll(/^--- ([^\r\n]+) ---\r?$/gmu)];
  // Each header must name its input's proven source; several inputs may resolve to one shell.
  if (
    headers.length !== paths.length ||
    headers.some((header, index) => !sourceMatches(paths[index], header[1] ?? ""))
  )
    return [];
  const prefix = output.slice(0, headers[0]?.index).trim();
  if (prefix && !/^<system-result\b[^>]*><uuid>[a-f0-9-]+<\/uuid><\/system-result>$/iu.test(prefix))
    return [];
  return headers.map((header, index) => ({
    ...issuer,
    args: { ...issuer.args, path: paths[index] },
    end: {
      ...issuer.end,
      result: {
        // The combined envelope grants no per-item result authority.
        content: [
          {
            type: "text",
            text: output.slice(header.index + header[0].length + 1, headers[index + 1]?.index),
          },
        ],
      },
    },
  }));
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
    if (toolSemantics(issuer.tool) === "read") {
      // Unprojected combined displays have no per-source selection authority.
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
        wholeSearchSelection(value, issuer.end) &&
        data.complete === true &&
        data.matches.length === 1;
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
      const endLine = range.endLine ?? number + (match.lineText.match(/\n/gu)?.length ?? 0);
      if (typeof endLine !== "number" || !Number.isInteger(endLine) || endLine < number) continue;
      const lastContainingLine = endLine > number && range.endColumn === 0 ? endLine - 1 : endLine;
      const to = lines[lastContainingLine] ?? content.length;
      const line = content.slice(from, to).replace(/\r?\n$/u, "");
      if (line !== match.lineText) continue;
      const lineReference = (issued && direct[2] === "line") || reference === references.line;
      if (lineReference) return { content, from, to };
      const column = range.startColumn;
      const containing = content.slice(from, to);
      const local = typeof column === "number" ? column : containing.indexOf(text);
      const endFrom = lines[endLine - 1];
      const endColumn = range.endColumn;
      const selectedTo = from + local + text.length;
      if (
        local < 0 ||
        !Number.isInteger(local) ||
        local > (lines[number] ?? content.length) - from ||
        content.slice(from + local, selectedTo) !== text ||
        (typeof endColumn === "number" &&
          (endFrom === undefined || endFrom + endColumn !== selectedTo)) ||
        (column === undefined && containing.indexOf(text, local + 1) >= 0)
      )
        continue;
      return { content, from: from + local, to: selectedTo };
    }
  }
  return undefined;
}
