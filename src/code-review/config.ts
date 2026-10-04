import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseDocument } from "yaml";

/** Project-owned review rules. Descriptions express both violations and allowed exceptions. */
export interface ReviewRule {
  readonly id: string;
  readonly description: string;
}

export const REVIEW_RULES_PATH = ".pi/pi-agent-ide/code-review.yaml";

const schema = Type.Object(
  {
    rules: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^[a-z][a-z0-9-]*$", maxLength: 64 }),
          description: Type.String({ minLength: 1, maxLength: 2048 }),
          enabled: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
  },
  { additionalProperties: false },
);

/** Parse one YAML document and reject typos, duplicate IDs and unbounded rule lists. */
export function parseReviewRules(source: string): readonly ReviewRule[] {
  if (Buffer.byteLength(source, "utf8") > 65_536)
    throw new Error("Review rules file is too large (64 KiB limit).");
  const document = parseDocument(source);
  const [error] = document.errors;
  if (error) throw new Error(error.message);
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!Value.Check(schema, value)) {
    throw new Error(
      "Expected rules: [{ id, description, enabled? }]; at most 32 rules with descriptions up to 2048 characters.",
    );
  }
  const ids = new Set<string>();
  const rules: ReviewRule[] = [];
  for (const rule of value.rules) {
    if (ids.has(rule.id)) throw new Error(`Duplicate review rule: ${rule.id}`);
    ids.add(rule.id);
    if (!rule.description.trim()) throw new Error(`Empty description for ${rule.id}`);
    if (rule.enabled !== false) rules.push({ id: rule.id, description: rule.description.trim() });
  }
  return rules;
}

/** Reload project rules per review; a missing file means no rules, not a default policy. */
export async function readReviewRules(cwd: string): Promise<readonly ReviewRule[]> {
  const file = path.resolve(cwd, REVIEW_RULES_PATH);
  try {
    return parseReviewRules(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `Cannot load ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
