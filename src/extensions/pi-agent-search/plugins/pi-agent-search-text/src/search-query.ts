import parser, { type LuceneQueryNode } from "lucene-query-parser";

interface CompiledExpression {
  readonly condition: string;
  readonly match: string;
}

export function compileSearchQuery(query: string): string {
  if (!containsBooleanOperator(query)) {
    return escapeRegex(query);
  }

  const normalizedQuery = query.replace(/\|{1,2}/gu, " OR ");
  const expression = compileExpression(parser.parse(normalizedQuery));
  return `^(?=${expression.condition}).*?(${expression.match})`;
}

function containsBooleanOperator(query: string): boolean {
  return /(?:^|\s)(?:AND|OR|NOT)(?=\s|$)|\|{1,2}/u.test(query);
}

function compileExpression(node: LuceneQueryNode, inheritedField?: string): CompiledExpression {
  const field = concreteField(node.field) ?? inheritedField;

  if (typeof node.term === "string") {
    return compileTerm(node, field);
  }

  if (
    node.left === undefined ||
    node.operator === undefined ||
    node.right === undefined ||
    node.right === null
  ) {
    throw new Error("Search query must contain a searchable expression.");
  }

  const left = compileExpression(node.left, field);
  const right = compileExpression(node.right, field);

  switch (node.operator) {
    case "OR": {
      return {
        condition: `(?:${left.condition}|${right.condition})`,
        match: `(?:${left.match}|${right.match})`,
      };
    }
    case "AND":
    case "<implicit>": {
      return {
        condition: `(?=.*(?:${left.condition}))(?=.*(?:${right.condition}))`,
        match: `(?:${left.match}|${right.match})`,
      };
    }
    case "NOT": {
      return {
        condition: `(?=.*(?:${left.condition}))(?!.*(?:${right.condition}))`,
        match: left.match,
      };
    }
    default: {
      throw new Error(`Search query operator ${JSON.stringify(node.operator)} is not supported.`);
    }
  }
}

function compileTerm(node: LuceneQueryNode, field: string | undefined): CompiledExpression {
  if (node.prefix !== undefined && node.prefix !== null) {
    throw new Error("Search query prefix operators are not supported.");
  }

  if (node.similarity !== undefined && node.similarity !== null) {
    throw new Error("Search query fuzzy operators are not supported.");
  }

  if (node.proximity !== undefined && node.proximity !== null) {
    throw new Error("Search query proximity operators are not supported.");
  }

  if (node.boost !== undefined && node.boost !== null) {
    throw new Error("Search query boost operators are not supported.");
  }

  if (node.regexpr === true) {
    throw new Error("Use the explicit regex: search protocol for regular expressions.");
  }

  const term = normalizeTerm(node.term);

  if (term.length === 0) {
    throw new Error("Search query terms must not be empty.");
  }

  const pattern = field === undefined ? escapeRegex(term) : fieldPattern(field, term);
  return { condition: pattern, match: pattern };
}

function concreteField(field: string | undefined): string | undefined {
  return field === undefined || field === "<implicit>" ? undefined : field;
}

function normalizeTerm(term: string | undefined): string {
  if (term === undefined) {
    throw new Error("Search query term is missing.");
  }

  return term.length >= 2 && term.startsWith("'") && term.endsWith("'") ? term.slice(1, -1) : term;
}

function fieldPattern(field: string, term: string): string {
  return `["']?\\b${escapeRegex(field)}\\b["']?\\s*:\\s*["']?${escapeRegex(term)}["']?`;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}
