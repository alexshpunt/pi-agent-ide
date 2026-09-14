import {
  TextAnchor,
  type TextAnchorResolutionAttempt,
  type TextAnchorResolver,
  type TextAnchorResolverContext,
} from "pi-agent-text";

class ConstantTextAnchor extends TextAnchor {
  public constructor(value: "begin" | "end", lineNumber: number) {
    super(value, lineNumber);
  }
}

export function createConstantTextAnchorResolver(): TextAnchorResolver {
  return {
    id: "file-position",
    description: "`begin` and `end` select the first and last existing lines.",
    renderFull(value) {
      return value;
    },
    renderCompact(value) {
      return value === "begin" ? "file start" : "file end";
    },
    tryResolve(value, context) {
      return Promise.resolve(resolveConstantAnchor(value, context));
    },
  };
}

function resolveConstantAnchor(
  value: string,
  context: TextAnchorResolverContext,
): TextAnchorResolutionAttempt {
  if (value !== "begin" && value !== "end") {
    return { kind: "not-handled" };
  }

  if (context.lines.length === 0) {
    return { kind: "failed", error: new Error(`${value} cannot resolve in an empty file`) };
  }

  return {
    kind: "resolved",
    anchor: new ConstantTextAnchor(value, value === "begin" ? 1 : context.lines.length),
  };
}
