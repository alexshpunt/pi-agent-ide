import { parser } from "@lezer/javascript";
import { TreeFragment, type Tree } from "@lezer/common";

const helpers = new Set([
  "read",
  "search",
  "diff",
  "write",
  "replace",
  "insert",
  "remove",
  "copy",
  "move",
  "undo",
  "stage",
  "unstage",
  "delete_file",
  "copy_file",
  "move_file",
]);

/** Bounded source expression; literal does not imply the operation has executed. */
export interface PreviewArgument {
  readonly text: string;
  readonly literal: boolean;
}
/** A written call preview, never evidence that the call executed. */
export interface ApplyCallPreview {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly path?: PreviewArgument;
  readonly query?: PreviewArgument;
  readonly target?: PreviewArgument;
  readonly before?: PreviewArgument;
  readonly after?: PreviewArgument;
  readonly arguments: Readonly<Record<string, PreviewArgument>>;
}

/** Recover helper calls from incomplete JavaScript without evaluating arguments. */
export function parseApplyCalls(
  source: string,
  tree: Tree = parser.parse(source),
): ApplyCallPreview[] {
  const shadows: { name: string; from: number; to: number }[] = [];
  tree.iterate({
    enter(node) {
      if (node.name === "AssignmentExpression") {
        const target = node.node.firstChild;
        if (target?.name === "VariableName")
          shadows.push({ name: source.slice(target.from, target.to), from: 0, to: source.length });
      }
      if (node.name !== "VariableDefinition") return;
      let declaration = node.node.parent;
      while (
        declaration?.parent &&
        !["VariableDeclaration", "ParamList", "Block", "Script"].includes(declaration.name)
      )
        declaration = declaration.parent;
      const hoisted =
        declaration?.name === "VariableDeclaration" && declaration.firstChild?.name === "var";
      const boundaries = new Set([
        "Script",
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunction",
        ...(hoisted ? [] : ["Block"]),
      ]);
      let scope = node.node.parent;
      if (scope?.name === "FunctionDeclaration") scope = scope.parent;
      while (scope?.parent && !boundaries.has(scope.name)) scope = scope.parent;
      shadows.push({
        name: source.slice(node.from, node.to),
        from: scope?.from ?? 0,
        to: scope?.to ?? source.length,
      });
    },
  });
  const calls: ApplyCallPreview[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== "CallExpression") return;
      const callee = node.node.firstChild;
      if (callee?.name !== "VariableName") return;
      const name = source.slice(callee.from, callee.to);
      if (
        !helpers.has(name) ||
        shadows.some(
          (binding) => binding.name === name && binding.from <= node.from && binding.to >= node.to,
        )
      )
        return;
      const object = node.node.getChild("ArgList")?.getChild("ObjectExpression");
      const fields = Object.create(null) as Record<string, PreviewArgument>;
      if (!object) {
        const args = node.node.getChild("ArgList");
        const raw = args ? source.slice(args.from + 1, args.to).replace(/\)$/, "") : "";
        if (raw)
          fields.arguments = {
            text: raw.length > 160 ? raw.slice(0, 120) + "…" : raw,
            literal: false,
          };
      }
      for (const property of object?.getChildren("Property") ?? []) {
        const key = property.firstChild;
        const rawKey = key ? source.slice(key.from, key.to) : "";
        const field = rawKey.replace(/^["']|["']$/g, "");
        if (!/^[a-zA-Z_$][\w$]*$/.test(field)) {
          // Computed keys and spreads can replace any earlier identity argument.
          for (const identity of ["path", "query", "target", "before", "after"])
            delete fields[identity];
          const raw = source.slice(property.from, property.to);
          fields[`argument@${property.from}`] = {
            text: raw.length > 160 ? raw.slice(0, 160) + "…" : raw,
            literal: false,
          };
          continue;
        }
        const value = property.lastChild;
        if (!value || value.type.isError || value.name === ":") continue;
        const raw = source.slice(value.from, value.to);
        const singleLine = raw.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
        const anchor =
          /^(?:["'])(?:\d+#[0-9A-F]+|CHANGE#[0-9A-F]+|begin|end|scope-(?:begin|end)-[^"']+)["']$/.test(
            raw,
          );
        fields[field] = {
          text:
            singleLine.length > 160 && !anchor
              ? `${singleLine.slice(0, 100)}…${singleLine.slice(-40)} (${raw.length} source chars)`
              : singleLine,
          literal:
            ["String", "Number", "BooleanLiteral", "Null"].includes(value.name) &&
            value.lastChild?.type.isError !== true,
        };
      }
      calls.push({
        name,
        from: node.from,
        to: node.to,
        path: fields.path,
        query: fields.query,
        target: fields.target,
        before: fields.before,
        after: fields.after,
        arguments: fields,
      });
      return false;
    },
  });
  return calls;
}

/** Compact written calls only; source and execution are never changed. */
export function compactApplySource(
  source: string,
  calls = parseApplyCalls(source),
  renderCall?: (call: ApplyCallPreview) => string,
  renderCode: (source: string) => string = (source) => source,
): string {
  let cursor = 0;
  const parts: string[] = [];
  const codePreview = (text: string) =>
    renderCode(
      text
        .split("\n")
        .map((line) => (line.length > 200 ? line.slice(0, 200) + "…" : line))
        .join("\n"),
    );
  for (const call of calls) {
    parts.push(codePreview(source.slice(cursor, call.from)));
    parts.push(
      renderCall?.(call) ??
        `${call.name}(${call.path ? (call.path.literal ? call.path.text : `‹${call.path.text}›`) : "…"})`,
    );
    cursor = call.to;
  }
  parts.push(codePreview(source.slice(cursor)));
  return parts.join("");
}

/** Reuse syntax trees across streamed argument updates and repeated terminal paints. */
export function createApplySourceProjection(
  renderCall?: (call: ApplyCallPreview) => string,
  renderCode?: (source: string) => string,
): (source: string) => string {
  let previous = "";
  let output = "";
  let fragments: readonly TreeFragment[] = [];
  return (source) => {
    if (source === previous) return output;
    let shared = 0;
    while (
      shared < previous.length &&
      shared < source.length &&
      previous[shared] === source[shared]
    )
      shared++;
    fragments = TreeFragment.applyChanges(fragments, [
      { fromA: shared, toA: previous.length, fromB: shared, toB: source.length },
    ]);
    const tree = parser.parse(source, fragments);
    fragments = TreeFragment.addTree(tree);
    output = compactApplySource(source, parseApplyCalls(source, tree), renderCall, renderCode);
    previous = source;
    return output;
  };
}
