import { expect, test } from "vitest";
import { createAstOutlineResolver } from "#src/outline-resolver.js";

test("explicit SSH outlines parse the owner snapshot and keep source mappings remote", async () => {
  const source = "ssh://fixture/work/example.ts";
  const lines = [
    "export function greet() {",
    '  const label = "café";',
    "  const count = 1;",
    "  return label + count;",
    "}",
  ];
  const calls: string[] = [];
  const resolver = createAstOutlineResolver(undefined, async (path, context) => {
    calls.push(path);
    expect(context.cwd).toBe("/unused-local-workspace");
    return { source, lines };
  });
  const result = await resolver.tryResolve(`ast:${source}`, { cwd: "/unused-local-workspace" });
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved") throw new Error("Expected an outline resource");
  if (result.resource.read === undefined) throw new Error("Expected a readable outline");
  const content = await result.resource.read({});
  const first = content[0];
  if (first.type !== "text") throw new Error("Expected outline text");
  expect(first.text).toContain(source);
  expect(JSON.stringify(content)).not.toContain("/unused-local-workspace/ssh:");
  expect(JSON.stringify(content)).toContain("scope-begin-");
  expect(calls).toEqual([source]);
});
