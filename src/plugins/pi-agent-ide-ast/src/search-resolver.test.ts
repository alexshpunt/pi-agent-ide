import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import { SearchSessionStore } from "pi-agent-search-text/search-session";
import { createAstSearchResolver } from "./search-resolver.js";

test("AST matches and captures stay inside one exact scope with their source authority", async () => {
  const base = path.resolve(".tmp/ast-scoped-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "note.ts");
  const first = 'function greet(value: string) { return value + " café"; }';
  const content = first + "\r\nfunction outside(other: string) { return other; }\r\n";
  await writeFile(source, content);
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
  const scope = {
    complete: false,
    targets: [
      {
        source,
        expectedContent: content,
        readCurrent: () => readFile(source, "utf8"),
        ranges: [
          { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: first.length } },
        ],
      },
    ],
  };
  const result = await resolver.tryResolve(
    { query: "ast:function $NAME($$$ARGS) { $$$BODY }" },
    { cwd, scope },
  );
  if (result.kind !== "resolved") throw new Error("AST discovery failed");
  const data = resolver.toScriptData?.(result.payload, {}) as {
    complete: boolean;
    matches: { source: string; captures?: Record<string, unknown> }[];
  };
  expect(data.complete).toBe(false);
  expect(data.matches).toHaveLength(1);
  expect(data.matches[0]?.source).toBe(source);
  const named = targets.resolve(data.matches[0]?.captures?.NAME, cwd);
  expect(named.complete).toBe(false);
  expect(named.targets[0]?.ranges).toEqual([
    { start: { lineNumber: 1, column: 9 }, end: { lineNumber: 1, column: 14 } },
  ]);
  await targets.verify(named);
  await writeFile(source, content.replace("greet", "later"));
  await expect(targets.verify(named)).rejects.toThrow("stale");
});
