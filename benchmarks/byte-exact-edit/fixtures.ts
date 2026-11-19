/** Invisible characters the fixture carries, by code point. */
export const BOM = "\ufeff";
export const NBSP = "\u00a0";
export const NNBSP = "\u202f";
export const ZWSP = "\u200b";
export const WJ = "\u2060";
export const SHY = "\u00ad";

/** The name of the edited file inside each run's workspace. */
export const FIXTURE_FILE = "routes.ts";

/**
 * One edit: replace `old` in the unique occurrence of `before + old + after`.
 * The expected file is `file[:start] + replacement + file[end:]`, byte for byte.
 */
export interface VariantEdit {
  before: string;
  old: string;
  after: string;
  replacement: string;
}

export interface Variant {
  id: string;
  /** What the variant probes, for the report and docs. */
  summary: string;
  /** Prose task given to the agent; it does not mention the invisible characters. */
  prompt: string;
  edit: VariantEdit;
  /** Whether a graded file shows the intended change, regardless of other damage. */
  intended(text: string): boolean;
}

/** Small deterministic PRNG (mulberry32), so every checkout generates the same bytes. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const ROUTE_LINE_OFFSET = 10;
const routeLine = (id: number) => ROUTE_LINE_OFFSET + id - 1;

function lineOf(text: string, needle: string): string | undefined {
  return text.split("\n").find((line) => line.includes(needle));
}

/**
 * An ordinary-looking 75-line TypeScript file: a BOM, U+00A0, U+200B, U+202F, U+2060 and U+00AD,
 * a tab indent among space indents, trailing spaces and a trailing tab, CRLF on about a third of
 * the lines, and no line break at the end of the file.
 */
export function fixtureText(): string {
  const lines: string[] = [
    BOM + "// Checkout routes used by the payment service.",
    `// Keep entries sorted by id; retries are per${NBSP}attempt.`,
    "",
    "export interface Route {",
    "  id: string;",
    "\tfeature: string;",
    "  retries: number;   ",
    "}",
    "",
    "export const routes: Route[] = [",
  ];
  for (let id = 1; id <= 60; id++) {
    const feature = id % 7 === 0 ? `legacy${ZWSP}Checkout` : "legacyCheckout";
    const separator = id % 5 === 0 ? NBSP : " ";
    let line = `  { id: "checkout-${id}",${separator}feature: "${feature}", retries: 3 },`;
    if (id % 9 === 0) line += " ";
    if (id % 11 === 0) line = line.replace("{ id", `{${WJ} id`);
    lines.push(line);
  }
  lines.push(
    "];",
    "",
    `// Re${SHY}try policy: the gateway retries a failed call at most three times.`,
    "export const maxRetries = 3;\t",
    `export${NBSP}default routes;`,
  );
  // The middle task's line is dirty on purpose; "retries: 3" itself stays clean.
  lines[routeLine(30)] =
    `  { id: "checkout-30",${NBSP}feature: "legacy${ZWSP}Checkout", retries: 3${NNBSP}},`;

  const next = random(77);
  const endings = lines.map((_, index) =>
    index === lines.length - 1 ? "" : next() < 0.33 ? "\r\n" : "\n",
  );
  // The BOM task's first line ends with LF, so the BOM is its only special character.
  endings[0] = "\n";
  // The CRLF task edits the end of the last route: a CRLF line between two LF lines.
  endings[routeLine(59)] = "\n";
  endings[routeLine(60)] = "\r\n";
  endings[routeLine(60) + 1] = "\n";
  return lines.map((line, index) => line + endings[index]).join("");
}

export const variants: readonly Variant[] = [
  {
    id: "mid",
    summary: "a value on a dirty line in the middle of the file",
    prompt:
      "In routes.ts, change the retries value of the route with id checkout-30 from 3 to 5. Change nothing else in the file.",
    edit: {
      before: `{ id: "checkout-30",${NBSP}feature: "legacy${ZWSP}Checkout", retries: `,
      old: "3",
      after: `${NNBSP}},`,
      replacement: "5",
    },
    intended: (text) => /retries:\s*5\b/u.test(lineOf(text, "checkout-30") ?? ""),
  },
  {
    id: "end",
    summary: "the last line of a file without a final line break",
    prompt:
      "In routes.ts, the last line exports routes as the default export. Make it export routeTable as the default export instead, by renaming routes to routeTable in that line only. Change nothing else in the file.",
    edit: { before: `export${NBSP}default `, old: "routes", after: ";", replacement: "routeTable" },
    intended: (text) => /export\s+default\s+routeTable;\s*$/u.test(text),
  },
  {
    id: "crlf",
    summary: "the end of a CRLF line between two LF lines",
    prompt:
      "In routes.ts, the last route in the routes array, the one with id checkout-60, ends with a trailing comma. Remove that trailing comma. Change nothing else in the file.",
    edit: {
      before: `{ id: "checkout-60",${NBSP}feature: "legacyCheckout", retries: 3 }`,
      old: ",",
      after: "\r\n];\n",
      replacement: "",
    },
    intended: (text) => /\}\s*$/u.test(lineOf(text, "checkout-60") ?? ""),
  },
  {
    id: "bom",
    summary: "the first line of a file that starts with a BOM",
    prompt:
      "In routes.ts, turn the line comment on the first line into a block comment, so that the first line reads /* Checkout routes used by the payment service. */ instead of // Checkout routes used by the payment service. Change nothing else in the file.",
    edit: {
      before: BOM,
      old: "// Checkout routes used by the payment service.",
      after: "\n// Keep",
      replacement: "/* Checkout routes used by the payment service. */",
    },
    intended: (text) =>
      (text.replace(/^\ufeff/u, "").split("\n")[0] ?? "").trimEnd() ===
      "/* Checkout routes used by the payment service. */",
  },
];

/** The span a variant replaces in the fixture; throws unless its context occurs exactly once. */
export function editSpan(text: string, edit: VariantEdit): { start: number; end: number } {
  const context = edit.before + edit.old + edit.after;
  const at = text.indexOf(context);
  if (at < 0 || text.indexOf(context, at + 1) >= 0)
    throw new Error(`Edit context must occur exactly once: ${JSON.stringify(context)}`);
  const start = at + edit.before.length;
  return { start, end: start + edit.old.length };
}

/** The expected file of a variant: `file[:start] + replacement + file[end:]`. */
export function expectedText(text: string, variant: Variant): string {
  const { start, end } = editSpan(text, variant.edit);
  return text.slice(0, start) + variant.edit.replacement + text.slice(end);
}
