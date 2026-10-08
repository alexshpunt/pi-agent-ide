import ts from "typescript";

export type Label = "prose" | "contract" | "unknown";
export interface AuditCase {
  id: string;
  file: string;
  line: number;
  split: "development" | "holdout";
  expected: Label;
  rationale: string;
  origin?: "repository" | "synthetic";
  source?: string;
}
export interface Classification {
  expected: Label;
  predicted: Label | "error";
}

/** Build model input without exposing the reference label, split, or rationale. */
export function buildState(item: AuditCase, source: string) {
  if (source.length > 60_000) throw new Error("Source exceeds the experiment's context bound.");
  const file = ts.createSourceFile(item.file, source, ts.ScriptTarget.Latest, true);
  const matches: ts.ExpressionStatement[] = [];
  function visit(node: ts.Node) {
    if (ts.isExpressionStatement(node)) {
      const start = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      const end = file.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      if (
        start <= item.line &&
        end >= item.line &&
        /^(?:await\s+)?expect(?:\(|\.)/u.test(node.getText(file))
      )
        matches.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (matches.length !== 1)
    throw new Error(
      `Expected one assertion at ${item.file}:${item.line}; found ${matches.length}.`,
    );
  const target = matches[0];
  if (!target) throw new Error("Missing assertion.");
  return { file: item.file, line: item.line, targetAssertion: target.getText(file), source };
}

/** Measure agreement with provisional reference labels; errors are never clean checks. */
export function summarize(rows: readonly Classification[]) {
  const confusion = Object.fromEntries(
    (["prose", "contract", "unknown"] as const).map((label) => [
      label,
      { prose: 0, contract: 0, unknown: 0, error: 0 },
    ]),
  ) as Record<Label, Record<Label | "error", number>>;
  for (const row of rows) confusion[row.expected][row.predicted] += 1;
  const flagged = rows.filter((row) => row.predicted === "prose").length;
  const positives = rows.filter((row) => row.expected === "prose").length;
  const truePositives = confusion.prose.prose;
  return {
    total: rows.length,
    correct: rows.filter((row) => row.expected === row.predicted).length,
    errors: rows.filter((row) => row.predicted === "error").length,
    abstentions: rows.filter((row) => row.predicted === "unknown").length,
    prosePrecision: flagged ? truePositives / flagged : null,
    proseRecall: positives ? truePositives / positives : null,
    confusion,
  };
}
