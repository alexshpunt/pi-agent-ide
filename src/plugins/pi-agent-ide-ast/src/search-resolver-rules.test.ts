import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import { SearchSessionStore } from "pi-agent-search-text/search-session";
import { createAstSearchResolver, type AstSearchOptions } from "./search-resolver.js";

const python = [
  "def outer(a):",
  "    def inner(b):",
  "        return send(b, 1)",
  "    return send(a, 2)",
  "",
].join("\n");

async function fixture() {
  const base = path.resolve(".tmp/ast-rule-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "calls.py");
  await writeFile(source, python);
  const targets = new ResultTargetStore();
  const sessions = new SearchSessionStore(undefined, targets, (file) => readFile(file, "utf8"));
  const resolver = createAstSearchResolver((selection, context) =>
    sessions.register(
      selection.request.query,
      selection.matches,
      selection.complete,
      context.cwd,
      context.signal,
      selection.request,
      selection.refresh,
      undefined,
      context.environment,
    ),
  );
  const run = async (
    ast: AstSearchOptions,
    scope?: Parameters<typeof resolver.tryResolve>[1]["scope"],
  ) => {
    const result = await resolver.tryResolve(
      { query: "label", path: source, options: { ast } },
      { cwd, ...(scope === undefined ? {} : { scope }) },
    );
    if (result.kind !== "resolved") throw new Error(`AST search ${result.kind}`);
    const data = resolver.toScriptData?.(result.payload, {}) as {
      matches: { range: { startLine: number } }[];
    };
    return data.matches.map((match) => match.range.startLine);
  };
  return { source, run };
}

test("a relational rule finds calls in a function's own body, skipping nested functions", async () => {
  const { run } = await fixture();

  const lines = await run({
    language: "python",
    rule: {
      pattern: "send($$$)",
      inside: {
        kind: "function_definition",
        stopBy: { kind: "function_definition" },
        has: { field: "name", regex: "^outer$" },
      },
    },
  });

  expect(lines).toEqual([4]);
});

test("enclosing returns the innermost matching construct around each scope range", async () => {
  const { source, run } = await fixture();
  const scope = {
    complete: true,
    targets: [
      {
        source,
        expectedContent: python,
        readCurrent: () => readFile(source, "utf8"),
        ranges: [
          { start: { lineNumber: 3, column: 15 }, end: { lineNumber: 3, column: 19 } },
          { start: { lineNumber: 4, column: 11 }, end: { lineNumber: 4, column: 15 } },
        ],
      },
    ],
  };

  const lines = await run(
    { language: "python", rule: { kind: "function_definition" }, relation: "enclosing" },
    scope,
  );

  expect(lines).toEqual([1, 2]);
});

test("an invalid rule fails instead of returning no matches", async () => {
  const { run } = await fixture();

  await expect(run({ language: "python", rule: { kind: "no_such_kind" } })).rejects.toThrow(
    /no_such_kind/u,
  );
});
