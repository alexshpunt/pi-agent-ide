import { formatSymbolSelector } from "pi-agent-ide/api/code-view";

import { textInRange } from "./corrected-names.ts";

import type { LspDocumentSymbol } from "./symbols.ts";
import type { LspRange } from "./types.ts";

/** A document symbol with the selector that names its declaration alone. */
export interface LspCodeSymbol {
  readonly name: string;
  readonly kind: number;
  /** The server's detail, such as clangd's signature `int (int, int) const`. */
  readonly detail?: string;
  readonly range: LspRange;
  readonly selectionRange: LspRange;
  /**
   * Path of segments from the outermost symbol. A segment carries the parameter types when a
   * sibling declaration has the same name, such as `clamp(int, int, int)`.
   */
  readonly selector: readonly string[];
  readonly children: readonly LspCodeSymbol[];
}

/** Parameter types and trailing qualifiers of a function signature. */
interface Signature {
  readonly parameters: readonly string[];
  readonly qualifiers: string;
}

const OPENING = "(<[{";
const CLOSING = ")>]}";

/** Builds symbols sorted by position, each with the selector that names its declaration alone. */
export function normalizeDocumentSymbols(
  symbols: readonly LspDocumentSymbol[],
  parentSelector: readonly string[] = [],
): LspCodeSymbol[] {
  const present = symbols
    .map((symbol) => ({ symbol, selectionRange: symbol.selectionRange ?? symbol.range }))
    .filter(
      (item): item is { symbol: LspDocumentSymbol; selectionRange: LspRange } =>
        item.selectionRange !== undefined,
    );
  const keysByName = new Map<string, Set<string>>();
  for (const { symbol, selectionRange } of present) {
    const keys = keysByName.get(symbol.name) ?? new Set<string>();
    keys.add(declarationKey(symbol, selectionRange));
    keysByName.set(symbol.name, keys);
  }
  return present
    .map(({ symbol, selectionRange }) => {
      const overloaded = (keysByName.get(symbol.name)?.size ?? 0) > 1;
      const segment = overloaded
        ? (signatureSegment(symbol.name, symbol.detail) ?? symbol.name)
        : symbol.name;
      const selector = [...parentSelector, segment];
      return {
        name: symbol.name,
        kind: symbol.kind,
        ...(symbol.detail !== undefined && symbol.detail !== "" && { detail: symbol.detail }),
        range: symbol.range ?? selectionRange,
        selectionRange,
        selector,
        children: normalizeDocumentSymbols(symbol.children ?? [], selector),
      };
    })
    .sort(compareSymbols);
}

/**
 * The entries of one declaration that `selector` names. A segment is a name, or a name with
 * parameter types such as `clamp(int, int, int)`; a single segment is looked up at any depth.
 * Entries with the same name, kind and signature in one scope, such as a C++ prototype and its
 * definition, are one declaration. Fails when the selector names none or several declarations.
 */
export function resolveSymbolDeclaration(
  symbols: readonly LspCodeSymbol[],
  selector: readonly string[],
  displayPath: string,
): readonly LspCodeSymbol[] {
  if (selector.length === 0)
    throw new TypeError("A symbol selector must contain at least one segment.");
  let scope = symbols;
  let matches: LspCodeSymbol[] = [];
  for (const [index, segment] of selector.entries()) {
    matches =
      selector.length === 1 ? matchAtAnyDepth(symbols, segment) : matchSegment(scope, segment);
    if (matches.length === 0) throw symbolNotFound(symbols, selector, displayPath);
    const declarations = groupDeclarations(matches);
    if (declarations.length > 1)
      throw ambiguousSelector(declarations, selector, index, displayPath);
    scope = matches.flatMap((symbol) => symbol.children);
  }
  return matches;
}

/**
 * The entry of a declaration that holds its body, such as a C++ definition rather than its
 * prototype. `text` is the source the entries' ranges belong to.
 */
export function declarationBody(
  entries: readonly LspCodeSymbol[],
  text: string,
  displayPath: string,
): LspCodeSymbol {
  const body = bodyEntry(entries, text);
  if (body !== undefined) return body;
  const lines = entries.map((entry) => entry.selectionRange.start.line + 1).join(", ");
  throw new Error(
    `${displayPath}#${formatSymbolSelector(entries[0]?.selector ?? [])} is declared ${entries.length} times (lines ${lines}) and none is the only one with a body; select the text with a line anchor.`,
  );
}

/**
 * The only entry of a declaration, or the only one whose text ends with a body (`}`), such as a
 * C++ definition next to its prototype; undefined when that does not single one out.
 */
export function bodyEntry(
  entries: readonly LspCodeSymbol[],
  text: string,
): LspCodeSymbol | undefined {
  const [only] = entries;
  if (only !== undefined && entries.length === 1) return only;
  const bodies = entries.filter((entry) => textInRange(text, entry.range).trimEnd().endsWith("}"));
  return bodies.length === 1 ? bodies[0] : undefined;
}

/** Entries of `symbols` at any depth with the same name and signature, grouped by declaration. */
export function declarationsNamed(
  symbols: readonly LspCodeSymbol[],
  name: string,
): LspCodeSymbol[][] {
  const named = (items: readonly LspCodeSymbol[]): LspCodeSymbol[] =>
    items.flatMap((symbol) => [
      ...(symbol.name === name ? [symbol] : []),
      ...named(symbol.children),
    ]);
  return groupDeclarations(named(symbols));
}

/** The declaration entries that contain `range` as their name range. */
export function declarationAt(
  symbols: readonly LspCodeSymbol[],
  range: LspRange,
): LspCodeSymbol[] | undefined {
  const all = (items: readonly LspCodeSymbol[]): LspCodeSymbol[] =>
    items.flatMap((symbol) => [symbol, ...all(symbol.children)]);
  const flat = all(symbols);
  const entry = flat.find((symbol) => sameRange(symbol.selectionRange, range));
  if (entry === undefined) return undefined;
  return groupDeclarations(flat.filter((symbol) => symbol.name === entry.name)).find((group) =>
    group.includes(entry),
  );
}

function matchAtAnyDepth(symbols: readonly LspCodeSymbol[], segment: string): LspCodeSymbol[] {
  const named: LspCodeSymbol[] = [];
  const exact: LspCodeSymbol[] = [];
  const loose: LspCodeSymbol[] = [];
  const visit = (items: readonly LspCodeSymbol[]) => {
    for (const symbol of items) {
      const grade = segmentGrade(symbol, segment);
      if (grade === "named") named.push(symbol);
      else if (grade === "exact") exact.push(symbol);
      else if (grade === "loose") loose.push(symbol);
      visit(symbol.children);
    }
  };
  visit(symbols);
  return named.length > 0 ? named : exact.length > 0 ? exact : loose;
}

function matchSegment(symbols: readonly LspCodeSymbol[], segment: string): LspCodeSymbol[] {
  const graded = symbols.map((symbol) => ({ symbol, grade: segmentGrade(symbol, segment) }));
  for (const grade of ["named", "exact", "loose"] as const) {
    const found = graded.filter((item) => item.grade === grade).map((item) => item.symbol);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * How `segment` names `symbol`: by its exact name, by name and the exact signature, or by name
 * and parameter types that may carry parameter names, defaults or omit trailing qualifiers.
 */
function segmentGrade(
  symbol: LspCodeSymbol,
  segment: string,
): "named" | "exact" | "loose" | undefined {
  if (symbol.name === segment) return "named";
  if (!segment.startsWith(symbol.name)) return undefined;
  const rest = segment.slice(symbol.name.length).trimStart();
  if (!rest.startsWith("(")) return undefined;
  const wanted = parseSignature(rest);
  const actual = symbol.detail === undefined ? undefined : detailSignature(symbol.detail);
  if (wanted === undefined || actual === undefined) return undefined;
  if (wanted.parameters.length !== actual.parameters.length) return undefined;
  if (
    wanted.qualifiers === actual.qualifiers &&
    wanted.parameters.every((parameter, index) => parameter === actual.parameters[index])
  )
    return "exact";
  if (wanted.qualifiers !== "" && wanted.qualifiers !== actual.qualifiers) return undefined;
  return wanted.parameters.every((parameter, index) => {
    const type = actual.parameters[index];
    return parameter === type || withoutParameterName(parameter) === type;
  })
    ? "loose"
    : undefined;
}

function groupDeclarations(symbols: readonly LspCodeSymbol[]): LspCodeSymbol[][] {
  const groups = new Map<string, LspCodeSymbol[]>();
  for (const symbol of symbols) {
    const key = JSON.stringify([
      symbol.selector.slice(0, -1),
      symbol.name,
      declarationKey(symbol, symbol.selectionRange),
    ]);
    const group = groups.get(key) ?? [];
    group.push(symbol);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Entries with the same kind and signature declare one thing; without a signature, each is its own. */
function declarationKey(
  symbol: { readonly kind: number; readonly detail?: string },
  selectionRange: LspRange,
): string {
  const detail = symbol.detail?.trim().replace(/\s+/gu, " ") ?? "";
  return detail === ""
    ? JSON.stringify([symbol.kind, selectionRange.start.line, selectionRange.start.character])
    : JSON.stringify([symbol.kind, detail]);
}

/** `name(types) qualifiers` from a server signature detail, or undefined without one. */
function signatureSegment(name: string, detail: string | undefined): string | undefined {
  const signature = detail === undefined ? undefined : detailSignature(detail);
  if (signature === undefined) return undefined;
  const qualifiers = signature.qualifiers === "" ? "" : ` ${signature.qualifiers}`;
  return `${name}(${signature.parameters.join(", ")})${qualifiers}`;
}

/** The last top-level parameter list in a detail such as `template T (const T &) const`. */
function detailSignature(detail: string): Signature | undefined {
  let start: number | undefined;
  for (let index = 0; index < detail.length; index += 1) {
    if (detail[index] !== "(") {
      const close = matchingClose(detail, index);
      if (close !== undefined) index = close;
      continue;
    }
    start = index;
    const close = matchingClose(detail, index);
    if (close === undefined) return undefined;
    index = close;
  }
  return start === undefined ? undefined : parseSignature(detail.slice(start));
}

/** Parses `(types) qualifiers`; undefined when the parentheses do not balance. */
function parseSignature(text: string): Signature | undefined {
  const close = matchingClose(text, 0);
  if (close === undefined) return undefined;
  const inner = text.slice(1, close);
  const parameters = splitTopLevel(inner).map(normalizeType);
  const normalized =
    (parameters.length === 1 && (parameters[0] === "" || parameters[0] === "void")) ||
    parameters.length === 0
      ? []
      : parameters;
  return { parameters: normalized, qualifiers: normalizeType(text.slice(close + 1)) };
}

/** Index of the bracket closing the one at `open`, or undefined when `open` is no bracket. */
function matchingClose(text: string, open: number): number | undefined {
  if (!OPENING.includes(text[open] ?? "")) return undefined;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (OPENING.includes(character)) depth += 1;
    else if (CLOSING.includes(character)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (OPENING.includes(character)) depth += 1;
    else if (CLOSING.includes(character)) depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** One spelling per type: single spaces, none around punctuation (`const Vec &` is `const Vec&`). */
function normalizeType(text: string): string {
  return text
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\s*([&*,<>()[\]:])\s*/gu, "$1");
}

/** A parameter written with its name or default value, such as `float a = 0`, without them. */
function withoutParameterName(parameter: string): string {
  const declarator = parameter.replace(/=.*$/u, "").trim();
  const match = /^(.*?[\s&*>\]])[\p{L}_][\p{L}\p{N}_]*$/u.exec(declarator);
  return match?.[1] === undefined ? declarator : normalizeType(match[1]);
}

function compareSymbols(left: LspCodeSymbol, right: LspCodeSymbol): number {
  return (
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    left.name.localeCompare(right.name)
  );
}

function sameRange(left: LspRange, right: LspRange): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function describeDeclaration(group: readonly LspCodeSymbol[], displayPath: string): string {
  const [first] = group;
  if (first === undefined) return displayPath;
  const lines = group.map((entry) => entry.selectionRange.start.line + 1).join(", ");
  return `${displayPath}#${formatSymbolSelector(first.selector)} (line ${lines})`;
}

function ambiguousSelector(
  declarations: readonly (readonly LspCodeSymbol[])[],
  selector: readonly string[],
  index: number,
  displayPath: string,
): Error {
  const shown = declarations.slice(0, 10).map((group) => describeDeclaration(group, displayPath));
  const more =
    declarations.length > shown.length ? `, ${declarations.length - shown.length} more` : "";
  const selectors = new Set(
    declarations.map((group) => formatSymbolSelector(group[0]?.selector ?? [])),
  );
  const at = selector.length > 1 ? ` at "${selector[index] ?? ""}"` : "";
  const hint =
    selectors.size === declarations.length
      ? "Use one of these selectors."
      : "The language server reports no signatures that tell them apart.";
  return new Error(
    `Symbol selector "${formatSymbolSelector(selector)}"${at} matches ${declarations.length} declarations in ${displayPath}: ${shown.join(", ")}${more}. ${hint}`,
  );
}

function symbolNotFound(
  symbols: readonly LspCodeSymbol[],
  selector: readonly string[],
  displayPath: string,
): Error {
  const last = selector.at(-1) ?? "";
  const name = /^[^(]+/u.exec(last)?.[0].trim() ?? last;
  const known = name === last ? [] : declarationsNamed(symbols, name);
  const shown = known.slice(0, 10).map((group) => describeDeclaration(group, displayPath));
  return new Error(
    `Symbol "${formatSymbolSelector(selector)}" was not found in ${displayPath}.${shown.length > 0 ? ` Declarations named "${name}": ${shown.join(", ")}.` : ""}`,
  );
}
