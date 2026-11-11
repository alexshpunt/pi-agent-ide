import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import type { SearchSelectionMatch, SearchSelectionRegistration } from "pi-agent-search/api/search";
import {
  SearchSessionStore,
  SearchSnapshotChangedError,
} from "pi-agent-search-text/search-session";
import { createAstSearchResolver } from "./search-resolver.ts";

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
    {
      query: "function $NAME($$$ARGS) { $$$BODY }",
      options: { ast: { pattern: "function $NAME($$$ARGS) { $$$BODY }" } },
    },
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
  // A capture names exactly one range, so it is complete even when its search was limited.
  expect(named.complete).toBe(true);
  expect(named.targets[0]?.ranges).toEqual([
    { start: { lineNumber: 1, column: 9 }, end: { lineNumber: 1, column: 14 } },
  ]);
  await targets.verify(named);
  await writeFile(source, content.replace("greet", "later"));
  await expect(targets.verify(named)).rejects.toThrow("stale");
});

test("include globs keep comma-separated brace alternatives", async () => {
  const base = path.resolve(".tmp/ast-scoped-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "braces-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "note.ts"), "const kept = 1;\n");
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
  const result = await resolver.tryResolve(
    {
      query: "const $NAME = $VALUE;",
      path: ".",
      include: "**/*.{ts,md}",
      options: { ast: { pattern: "const $NAME = $VALUE;", language: "typescript" } },
    },
    { cwd },
  );
  if (result.kind !== "resolved") throw new Error("AST discovery failed");
  const data = resolver.toScriptData?.(result.payload, {}) as { matches: unknown[] };
  expect(data.matches).toHaveLength(1);
});

test("AST search of a result whose lines changed searches the current text of its region", async () => {
  const base = path.resolve(".tmp/ast-scoped-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "changed-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "note.ts");
  const lines = [
    "const above = 1;",
    "const first = 1;",
    "const second = 2;",
    "const third = 3;",
    "const below = 4;",
  ];
  await writeFile(source, `${lines.join("\n")}\n`);
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
  // A Read of the three middle lines.
  const reference = targets.register(
    [
      {
        source,
        expectedContent: `${lines.join("\n")}\n`,
        ranges: [{ start: { lineNumber: 2, column: 0 }, end: { lineNumber: 5, column: 0 } }],
      },
    ],
    cwd,
  );
  // Other sessions edit a line inside the range and add lines above it.
  const changed = ["const new = 0;", ...lines];
  changed[3] = "const second = 22;";
  await writeFile(source, `${changed.join("\n")}\n`);
  expect(() => targets.resolve(reference, cwd)).toThrow("expired");

  const rescope = (signal?: AbortSignal) => targets.resolveCurrent(reference, cwd, signal);
  const request = {
    query: "const $NAME = $VALUE;",
    options: { ast: { pattern: "const $NAME = $VALUE;" } },
  };
  const result = await resolver.tryResolve(request, { cwd, scope: await rescope(), rescope });
  if (result.kind !== "resolved") throw new Error("AST discovery failed");
  const data = resolver.toScriptData?.(result.payload, {}) as {
    matches: {
      range: { startLine: number };
      matchedText: string;
      target?: string;
      references?: { match: string };
    }[];
  };
  expect(data.matches.map((match) => match.matchedText)).toEqual([
    "const first = 1;",
    "const second = 22;",
    "const third = 3;",
  ]);
  expect(data.matches.map((match) => match.range.startLine)).toEqual([3, 4, 5]);

  // A match is anchored to the file as it is now, so an edit built from it passes its checks.
  const [match] = data.matches;
  const anchored = targets.resolve(data.matches[1]?.target, cwd);
  expect(anchored.targets[0]?.expectedContent).toBe(`${changed.join("\n")}\n`);
  await targets.verify(anchored);
  expect(match?.references?.match).toMatch(/^SEARCH#/u);
});

test("AST search retries with the scope resolved again when the file changes before anchoring", async () => {
  const base = path.resolve(".tmp/ast-scoped-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "retry-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "note.ts");
  const content = "const a = 1;\nconst b = 2;\n";
  await writeFile(source, content);
  const targets = new ResultTargetStore();
  const sessions = new SearchSessionStore(undefined, targets, (file) => readFile(file, "utf8"));
  let rescoped = 0;
  const resolver = createAstSearchResolver(async (selection, context) => {
    if (rescoped === 0) {
      // Another session writes between the search and the registration of its anchors.
      await writeFile(source, `// header\n${content}`);
    }
    return sessions.register(
      selection.request.query,
      selection.matches,
      selection.complete,
      context.cwd,
      context.signal,
      selection.request,
      selection.refresh,
      undefined,
      context.environment,
    );
  });
  const reference = targets.register(
    [
      {
        source,
        expectedContent: content,
        ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 3, column: 0 } }],
      },
    ],
    cwd,
  );
  const rescope = (signal?: AbortSignal) => {
    rescoped += 1;
    return targets.resolveCurrent(reference, cwd, signal);
  };
  const result = await resolver.tryResolve(
    {
      query: "const $NAME = $VALUE;",
      options: { ast: { pattern: "const $NAME = $VALUE;" } },
    },
    { cwd, scope: await targets.resolveCurrent(reference, cwd), rescope },
  );
  if (result.kind !== "resolved") throw new Error("AST discovery failed");
  const data = resolver.toScriptData?.(result.payload, {}) as {
    matches: { range: { startLine: number } }[];
  };
  expect(rescoped).toBeGreaterThan(0);
  expect(data.matches.map((match) => match.range.startLine)).toEqual([2, 3]);
});

test("AST matches map to UTF-16 columns and lines, and a refresh returns the text it searched", async () => {
  const base = path.resolve(".tmp/ast-scoped-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "positions-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "note.ts");
  const content = 'const café = "ü😀"; const b = 1;\r\nfunction f() {\r\n  return "é";\r\n}\r\n';
  await writeFile(source, content);
  // The match selection registers first, then one selection per capture.
  const refreshes: SearchSelectionRegistration["refresh"][] = [];
  const sessions = new SearchSessionStore(undefined, new ResultTargetStore());
  const resolver = createAstSearchResolver((selection, context) => {
    refreshes.push(selection.refresh);
    return sessions.register(
      selection.request.query,
      selection.matches,
      selection.complete,
      context.cwd,
      context.signal,
      selection.request,
      selection.refresh,
    );
  });
  const search = async (pattern: string) => {
    refreshes.length = 0;
    const result = await resolver.tryResolve(
      { query: pattern, path: "note.ts", options: { ast: { pattern } } },
      { cwd },
    );
    if (result.kind !== "resolved") throw new Error("AST discovery failed");
    return (result.payload as { matches: { selection: SearchSelectionMatch }[] }).matches.map(
      (match) => match.selection,
    );
  };

  const [constant] = await search("const b = $V;");
  const firstLine = 'const café = "ü😀"; const b = 1;';
  expect(constant).toMatchObject({
    lineNumber: 1,
    endLineNumber: 1,
    startColumn: firstLine.indexOf("const b"),
    endColumn: firstLine.length,
    lineText: firstLine,
  });
  const [declaration] = await search("function $N() { $$$B }");
  expect(declaration).toMatchObject({
    lineNumber: 2,
    endLineNumber: 4,
    startColumn: 0,
    endColumn: 1,
    lineText: "function f() {",
  });

  const refresh = refreshes[0];
  if (refresh === undefined) throw new Error("No refresh was registered");
  const refreshed = await refresh();
  expect(refreshed.contents?.get(source)).toBe(content);
});

test("AST anchors register from the text the search read while another session writes the file", async () => {
  const base = path.resolve(".tmp/ast-scoped-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "writer-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "note.ts");
  const content = "const a = 1;\nconst b = 2;\n";
  await writeFile(source, content);
  const targets = new ResultTargetStore();
  const sessions = new SearchSessionStore(undefined, targets, (file) => readFile(file, "utf8"));
  let writes = 0;
  const resolver = createAstSearchResolver(async (selection, context) => {
    // Another session inserts a line at the top of the file before every registration; the
    // matched lines keep their text and only move down.
    writes += 1;
    await writeFile(source, `${"// peer\n".repeat(writes)}${content}`);
    return sessions.register(
      selection.request.query,
      selection.matches,
      selection.complete,
      context.cwd,
      context.signal,
      selection.request,
      selection.refresh,
      undefined,
      context.environment,
      selection.contents,
    );
  });
  const result = await resolver.tryResolve(
    {
      query: "const $NAME = $VALUE;",
      path: "note.ts",
      options: { ast: { pattern: "const $NAME = $VALUE;" } },
    },
    { cwd },
  );
  if (result.kind !== "resolved") throw new Error("AST discovery failed");
  const data = resolver.toScriptData?.(result.payload, {}) as {
    matches: { matchedText: string; target?: string; captures?: Record<string, unknown> }[];
  };
  expect(data.matches.map((match) => match.matchedText)).toEqual(["const a = 1;", "const b = 2;"]);
  // Both the match and its captures registered, through writes between every registration.
  expect(writes).toBeGreaterThan(2);
  // The anchors describe the file as it is now, with the matched lines where the writer put them.
  const current = await readFile(source, "utf8");
  const anchored = targets.resolve(data.matches[0]?.target, cwd);
  expect(anchored.targets[0]?.expectedContent).toBe(current);
  expect(anchored.targets[0]?.ranges).toEqual([
    {
      start: { lineNumber: writes + 1, column: 0 },
      end: { lineNumber: writes + 1, column: "const a = 1;".length },
    },
  ]);
  await targets.verify(anchored);
  const named = targets.resolve(data.matches[0]?.captures?.NAME, cwd);
  expect(named.targets[0]?.ranges).toEqual([
    {
      start: { lineNumber: writes + 1, column: 6 },
      end: { lineNumber: writes + 1, column: 7 },
    },
  ]);
  await targets.verify(named);
});

test("AST search fails with a bounded, named reason when its file keeps changing", async () => {
  const base = path.resolve(".tmp/ast-scoped-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "unregistrable-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "note.ts");
  await writeFile(source, "const a = 1;\n");
  let attempts = 0;
  const resolver = createAstSearchResolver(() => {
    attempts += 1;
    // A file that changes again during every single search, so no snapshot can be registered.
    return Promise.reject(new SearchSnapshotChangedError(source));
  });
  await expect(
    resolver.tryResolve(
      {
        query: "const $NAME = $VALUE;",
        path: "note.ts",
        options: { ast: { pattern: "const $NAME = $VALUE;" } },
      },
      { cwd },
    ),
  ).rejects.toThrow(
    `Search result in ${source} changed before its anchors were registered. The structural search ran 5 times and another process wrote its files during every run. Repeat it when those writes stop.`,
  );
  expect(attempts).toBe(5);
});
