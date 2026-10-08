import type { CapabilityCase, RouteStep } from "./validation.ts";

const both = ["direct", "codemode"];
const reuse = (from: number, field: string | string[] = "path", kind = "result") => ({
  from,
  field,
  kind,
});
const textFile = { "task.txt": "keep\nOLD\nlast\n" };
const cases: CapabilityCase[] = [];
function add(
  id: string,
  capabilities: string[],
  prompt: string,
  steps: RouteStep[],
  extras: Partial<CapabilityCase> = {},
): void {
  cases.push({ id, capabilities, prompt, steps, modes: both, files: textFile, ...extras });
}

add(
  "read-text",
  ["read.text", "read.directory", "read.raw", "read.paging"],
  "Use read to list this directory, read only line 2 of task.txt, then read its first 4 original bytes through raw:. Report the line-2 value.",
  [
    { tool: "read", args: { path: "." } },
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 }, contains: "OLD" },
    { tool: "read", args: { path: "raw:task.txt", offset: 0, limit: 4 }, contains: "keep" },
  ],
  { answer: "OLD" },
);

add(
  "read-jq",
  ["read.jq"],
  "Use read with a jq view to select only .status from config.json and report its value. Do not edit anything.",
  [{ tool: "read", args: { path: "config.json", views: ["jq:.status"] }, contains: "ready" }],
  {
    files: { "config.json": '{"status":"ready","untouched":7}\n' },
    answer: "ready",
    prerequisite: "jq",
  },
);

add(
  "read-search-replace",
  ["compose.read-search", "compose.search-replace"],
  "Read task.txt. Pass the unchanged Read result or its UUID into search for OLD, then pass the Search result into replace to change just OLD to NEW. Do not retype a file path for the dependent calls.",
  [
    { tool: "read", args: { path: "task.txt" } },
    { tool: "search", args: { query: "OLD" }, reuse: reuse(0) },
    { tool: "replace", args: { text: "NEW" }, reuse: reuse(1) },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

const overviewFixtures = [
  { name: "lines", rows: 2100, padding: "  consume(value);" },
  { name: "bytes", rows: 1000, padding: `  consume("${"界".repeat(30)}");` },
].map(({ name, rows, padding }) => ({
  name,
  rows,
  files: {
    "large.ts": [
      'function outsideBefore() { return "NEEDLE"; }',
      "function checkout() {",
      ...Array<string>(100).fill(padding),
      '  consume("NEEDLE");',
      ...Array<string>(rows - 100).fill(padding),
      "}",
      'function outsideAfter() { return "NEEDLE"; }',
      "",
    ].join("\n"),
  },
}));
for (const { name, rows, files } of overviewFixtures) {
  add(
    `read-overview-search-${name}`,
    ["read.overview-source", "compose.overview-search", "compose.overview-window"],
    `Read all of large.ts so it returns a compact overview. Search for NEEDLE by passing that unchanged Read result or its UUID, not the file path. Then read large.ts with offset=2 and limit=${rows + 3}, and forward that new overview to Search for NEEDLE and outsideBefore. Report the source line of the body match and whether outsideBefore was found in the window. Do not edit anything.`,
    [
      { tool: "read", args: { path: "large.ts" }, contains: "Some source text is omitted." },
      {
        tool: "search",
        args: { query: "NEEDLE" },
        reuse: reuse(0),
        contains: "3 matches in 1 file",
      },
      {
        tool: "read",
        args: { path: "large.ts", offset: 2, limit: rows + 3 },
        contains: "outsideBefore",
      },
      {
        tool: "search",
        args: { query: "NEEDLE" },
        reuse: reuse(2),
        contains: "large.ts:103:12-18",
      },
      {
        tool: "search",
        args: { query: "outsideBefore" },
        reuse: reuse(2),
        contains: "No matches found",
      },
    ],
    { files, expected: files },
  );
}
const storedOverview = overviewFixtures[0];
if (storedOverview === undefined) throw new Error("Missing overview fixture");
add(
  "read-overview-store",
  ["compose.overview-store-load"],
  "In one Codemode call, read large.ts with offset=2 and limit=2103, and store the unchanged overview result. In a second successful Codemode call, load that result and search it for NEEDLE, then pass the Search result to replace NEEDLE with FOUND. Do not reread the file or retype its path for the dependent calls. Finally try Search using the saved overview again and confirm stale-input rejection.",
  [
    {
      tool: "read",
      args: { path: "large.ts", offset: 2, limit: 2103 },
      contains: "Some source text is omitted.",
    },
    {
      tool: "search",
      args: { query: "NEEDLE" },
      reuse: { ...reuse(0), newParent: true },
      contains: "large.ts:103:12-18",
    },
    { tool: "replace", args: { text: "FOUND" }, reuse: reuse(1) },
    { tool: "search", args: { query: "NEEDLE" }, reuse: reuse(0), error: true },
  ],
  {
    modes: ["codemode"],
    files: storedOverview.files,
    expected: {
      "large.ts": storedOverview.files["large.ts"].replace('consume("NEEDLE")', 'consume("FOUND")'),
    },
  },
);

add(
  "search-anchor-insert",
  ["search.text", "compose.search-insert", "edit.insert"],
  "Search for OLD using task.txt as path. Use the returned line anchor as insert.path, or use task.txt as path plus that anchor, to put NEW on the following line. Do not combine a result input with an anchor argument. Do not supply an extra blank line.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    { tool: "insert", args: { text: "NEW" }, reuse: reuse(0, ["anchor", "path"], "anchor") },
  ],
  { expected: { "task.txt": "keep\nOLD\nNEW\nlast\n" } },
);

add(
  "search-query",
  ["search.boolean", "search.regex", "search.files", "search.flags"],
  "Use search to find task*.txt files; then Boolean-search task.txt for lines containing alpha and beta but not skip. Finally regex-search for beta with wholeWord and caseSensitive set to true, limited to one result. Report the matching line.",
  [
    { tool: "search", args: { query: "files:task*.txt" } },
    {
      tool: "search",
      args: {
        path: "task.txt",
        query: /^(?:"alpha"|alpha) AND (?:"beta"|beta) NOT (?:"skip"|skip)$/,
      },
      contains: "PASS-MARKER",
    },
    {
      tool: "search",
      args: {
        path: "task.txt",
        query: /^regex:.*beta/,
        wholeWord: true,
        caseSensitive: true,
        limit: 1,
      },
      contains: "PASS-MARKER",
    },
  ],
  {
    files: { "task.txt": "alpha beta PASS-MARKER\nalpha beta skip\nAlpha BETAMAX\n" },
    answer: "alpha beta PASS-MARKER",
  },
);

add(
  "read-anchor-replace",
  ["read.anchors", "edit.replace-range"],
  "Read task.txt with anchors. Using both returned line anchors as start and end, replace the inclusive first two lines with one line READY. Use the file path or omit path for this anchored edit, not a result scope. Keep last unchanged.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    {
      tool: "replace",
      args: { start: /^1#/, end: /^2#/, text: /^READY\n?$/ },
      reuse: [reuse(0, "start", "anchor"), reuse(0, "end", "anchor")],
    },
  ],
  { expected: { "task.txt": "READY\nlast\n" } },
);

add(
  "write-read",
  ["edit.write", "compose.write-read"],
  "Use write to create answer.txt containing exactly ready plus a newline. Pass the returned whole-file result into read, and report the saved value.",
  [
    { tool: "write", args: { path: "answer.txt", content: "ready\n" } },
    { tool: "read", reuse: reuse(0), contains: "ready" },
  ],
  { expected: { "answer.txt": "ready\n" }, answer: "ready" },
);

add(
  "replace-read-search",
  ["edit.replace-exact", "compose.mutation-read", "compose.mutation-search"],
  "Follow replace → read → search in that order. Use replace with the exact OLD fragment in task.txt to change it to NEW. Pass the mutation result to read (this read is required), then search within that same mutation result for NEW. Keep everything else.",
  [
    { tool: "replace", args: { path: "task.txt", start: "OLD", text: "NEW" } },
    { tool: "read", reuse: reuse(0), contains: "NEW" },
    { tool: "search", args: { query: "NEW" }, reuse: reuse(0), contains: "NEW" },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

add(
  "insert-before",
  ["edit.insert-before", "edit.insert-spacing"],
  "Use insert before the exact OLD line to add a separate paragraph NOTE with blank-line separation.",
  [
    {
      tool: "insert",
      args: {
        text: "NOTE",
        before: true,
        separation: "blank-line",
      },
    },
  ],
  { expected: { "task.txt": "keep\n\nNOTE\n\nOLD\nlast\n" } },
);

add(
  "delete-selection",
  ["edit.delete-selection", "compose.search-delete"],
  "Search task.txt for the exact OLD fragment. Pass that Search result into delete, keeping the surrounding newline.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    { tool: "delete", reuse: reuse(0) },
  ],
  { expected: { "task.txt": "keep\n\nlast\n" } },
);

add(
  "file-copy-move-delete",
  ["edit.copy-file", "edit.move-file", "edit.delete-file"],
  "Use copy to duplicate task.txt into copied.txt, move copied.txt to moved.txt, then delete moved.txt. Use ordinary file paths for these whole-file operations, not result selections. The original must stay unchanged.",
  [
    { tool: "copy", args: { path: "task.txt", target: "copied.txt" } },
    { tool: "move", args: { path: "copied.txt", target: "moved.txt" } },
    { tool: "delete", args: { path: "moved.txt" } },
  ],
);

add(
  "selection-copy-move",
  ["edit.copy-selection", "edit.move-selection", "compose.select-copy", "compose.select-move"],
  "Read task.txt and select its second complete line. Copy that selection after the first line of dest.txt. Read task.txt again, select the original second line, and move it after the last line of dest.txt. Use Read results for select and selection results as copy/move sources. Use dest.txt as target with targetStart identifying DEST for copy and TAIL for move; do not replace a destination selection.",
  [
    { tool: "read", args: { path: "task.txt" } },
    { tool: "select", args: { operation: { kind: "lines", first: 2, last: 2 } }, reuse: reuse(0) },
    { tool: "copy", args: { target: "dest.txt", targetStart: /.+/ }, reuse: reuse(1) },
    { tool: "read", args: { path: "task.txt" } },
    { tool: "select", args: { operation: { kind: "lines", first: 2, last: 2 } }, reuse: reuse(3) },
    { tool: "move", args: { target: "dest.txt", targetStart: /.+/ }, reuse: reuse(4) },
  ],
  {
    files: { ...textFile, "dest.txt": "DEST\nTAIL\n" },
    expected: { "task.txt": "keep\nlast\n", "dest.txt": "DEST\nOLD\nTAIL\nOLD\n" },
  },
);

add(
  "paired-copy",
  ["compose.paired-sources-targets"],
  "Read a.txt and b.txt in separate calls. Also read dest-a.txt and dest-b.txt. Use copy with the two Read results as paired source and destination arrays, replacing both whole destination files.",
  [
    { tool: "read", args: { path: "a.txt" } },
    { tool: "read", args: { path: "b.txt" } },
    { tool: "read", args: { path: "dest-a.txt" } },
    { tool: "read", args: { path: "dest-b.txt" } },
    {
      tool: "copy",
      reuse: [reuse(0, "path.0"), reuse(1, "path.1"), reuse(2, "target.0"), reuse(3, "target.1")],
    },
  ],
  {
    files: { "a.txt": "A\n", "b.txt": "B\n", "dest-a.txt": "old-a\n", "dest-b.txt": "old-b\n" },
    expected: { "dest-a.txt": "A\n", "dest-b.txt": "B\n" },
  },
);

add(
  "read-diff",
  ["read.diff", "compose.read-diff"],
  "Read a.txt and b.txt separately. Pass their unchanged results or UUIDs as before and after to diff. Report the added line. Do not edit files.",
  [
    { tool: "read", args: { path: "a.txt" } },
    { tool: "read", args: { path: "b.txt" } },
    { tool: "diff", reuse: [reuse(0, "before"), reuse(1, "after")], contains: "NEW" },
  ],
  { files: { "a.txt": "OLD\n", "b.txt": "NEW\n" }, answer: "NEW" },
);

add(
  "undo-last",
  ["edit.undo-last", "compose.mutation-undo"],
  "Change OLD to NEW in task.txt using replace, then undo the last editor transaction using undo. Read the restored file and report its original marker.",
  [
    { tool: "replace", args: { path: "task.txt", start: "OLD", text: "NEW" } },
    { tool: "undo", args: { file: "task.txt", change: "last" } },
    { tool: "read", args: { path: "task.txt" }, contains: "OLD" },
  ],
  { answer: "OLD" },
);

add(
  "git-stage-unstage-undo",
  ["git.changes", "git.stage", "git.unstage", "git.undo-change", "discovery.git"],
  "Replace OLD with NEW in task.txt. Read its changes view, discover stage and unstage using native tool discovery, and stage the returned CHANGE anchor. Read changes again and unstage its current CHANGE anchor. Read changes once more and undo that current change. Leave source and index at the original clean state.",
  [
    { tool: "replace", args: { text: "NEW" } },
    { tool: "read", args: { path: "task.txt", views: ["changes"] } },
    { tool: "stage", args: { file: "task.txt" }, reuse: reuse(1, "change", "change") },
    { tool: "read", args: { path: "task.txt", views: ["changes"] } },
    { tool: "unstage", args: { file: "task.txt" }, reuse: reuse(3, "change", "change") },
    { tool: "read", args: { path: "task.txt", views: ["changes"] } },
    { tool: "undo", args: { file: "task.txt" }, reuse: reuse(5, "change", "change") },
  ],
  { git: true },
);

const geometric = [
  [
    "range",
    { kind: "range", startLine: 2, startColumn: 0, endLine: 2, endColumn: 3 },
    textFile,
    "keep\nNEW\nlast\n",
  ],
  ["lines", { kind: "lines", first: 2, last: 2 }, textFile, "keep\nNEW\nlast\n"],
  [
    "between",
    { kind: "between", start: "[", end: "]", extent: "inside" },
    { "task.txt": "[OLD]\n" },
    "[NEW]\n",
  ],
  ["sliceText", { kind: "sliceText", from: 5, to: 8 }, textFile, "keep\nNEW\nlast\n"],
  ["trim", { kind: "trim", side: "both" }, { "task.txt": "  OLD \n" }, "  NEW \n"],
  ["split", { kind: "split", delimiter: "|" }, { "task.txt": "OLD|OLD" }, "NEW|NEW"],
  [
    "columns",
    { kind: "columns", from: 2, to: 5 },
    { "task.txt": "aaOLDzz\naaOLDzz\n" },
    "aaNEWzz\naaNEWzz\n",
  ],
] as const;
for (const [kind, operation, files, expected] of geometric) {
  add(
    `select-${kind}`,
    [`select.${kind}`, "compose.read-select", "compose.select-replace"],
    `Read task.txt. Use select with the ${kind} operation to choose ${kind === "split" ? "the two delimiter-separated values" : kind === "trim" ? "the non-whitespace text" : "only the OLD text or line"}, then pass its result into replace to change the selection to NEW. Keep all other bytes. ${kind === "range" ? "Use line 2, columns 0 through 3 (exclusive)." : kind === "lines" ? "Choose line 2 including its line ending, and replace it with NEW plus that same line ending." : kind === "sliceText" ? "Use offsets 5 through 8 (exclusive)." : kind === "columns" ? "Use columns 2 through 5 (exclusive) on each line." : kind === "between" ? "Choose inside the square brackets." : kind === "split" ? "Split on the vertical bar." : "Trim both sides."}`,
    [
      { tool: "read", args: { path: "task.txt" } },
      { tool: "select", args: { operation }, reuse: reuse(0) },
      { tool: "replace", args: { text: kind === "lines" ? "NEW\n" : "NEW" }, reuse: reuse(1) },
    ],
    { files, expected: { "task.txt": expected } },
  );
}

add(
  "select-linesOf",
  ["select.linesOf"],
  "Search task.txt for OLD, expand the exact match into whole containing lines with select linesOf, then replace the entire selected line with only NEW plus its original line ending. Remove prefix and suffix, not just OLD. Keep the other lines unchanged.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    { tool: "select", args: { operation: { kind: "linesOf" } }, reuse: reuse(0) },
    { tool: "replace", args: { text: "NEW\n" }, reuse: reuse(1) },
  ],
  {
    files: { "task.txt": "keep\nprefix OLD suffix\nlast\n" },
    expected: { "task.txt": "keep\nNEW\nlast\n" },
  },
);

add(
  "select-position",
  ["select.position"],
  "Read task.txt. Select its zero-width after position and use replace to append NEW there, without replacing the existing file.",
  [
    { tool: "read", args: { path: "task.txt" } },
    { tool: "select", args: { operation: { kind: "position", edge: "after" } }, reuse: reuse(0) },
    { tool: "replace", args: { text: "NEW" }, reuse: reuse(1) },
  ],
  { expected: { "task.txt": "keep\nOLD\nlast\nNEW" } },
);

for (const kind of ["within", "intersection", "difference"]) {
  add(
    `select-${kind}`,
    [`select.${kind}`],
    `Read only line 1 of task.txt to get a comparison scope. Search the entire task.txt for OLD. Use select ${kind} with the Read result as scopes and the Search result as path. Replace the resulting selection with NEW.`,
    [
      { tool: "read", args: { path: "task.txt", offset: 1, limit: 1 } },
      { tool: "search", args: { path: "task.txt", query: "OLD" } },
      {
        tool: "select",
        args: { operation: { kind } },
        reuse: [reuse(1), reuse(0, "operation.scopes")],
      },
      { tool: "replace", args: { text: "NEW" }, reuse: reuse(2) },
    ],
    {
      files: { "task.txt": "OLD first\nOLD second\n" },
      expected: {
        "task.txt": kind === "difference" ? "OLD first\nNEW second\n" : "NEW first\nOLD second\n",
      },
    },
  );
}
add(
  "select-merge",
  ["select.merge"],
  "Read task.txt, pass an array containing that same result twice to select merge, then replace the merged whole-file selection with READY plus a newline. There must be just one resulting copy.",
  [
    { tool: "read", args: { path: "task.txt" } },
    { tool: "select", args: { operation: { kind: "merge" } }, reuse: reuse(0) },
    { tool: "replace", args: { text: "READY\n" }, reuse: reuse(1) },
  ],
  { expected: { "task.txt": "READY\n" } },
);

const syntax = { "task.ts": "function first() { return 7; }\nfunction second() { return 9; }\n" };
add(
  "select-object-part",
  ["select.object", "select.part", "read.ast", "search.ast"],
  "Read ast:task.ts. AST-search for return 7, take its match selection, select the enclosing function, then select the function's name part and replace it with renamed. Use the actual source references.",
  [
    { tool: "read", args: { path: "ast:task.ts" }, contains: "first" },
    { tool: "search", args: { path: "task.ts", query: "ast:return 7" } },
    {
      tool: "select",
      args: { operation: { kind: "object", object: "function" } },
      reuse: reuse(1),
    },
    { tool: "select", args: { operation: { kind: "part", part: "name" } }, reuse: reuse(2) },
    { tool: "replace", args: { text: "renamed" }, reuse: reuse(3) },
  ],
  {
    files: syntax,
    expected: { "task.ts": "function renamed() { return 7; }\nfunction second() { return 9; }\n" },
  },
);

add(
  "read-ast-boundary",
  ["read.ast-view", "edit.scope-anchors"],
  "Read task.ts with the ast view. Use the returned begin/end scope anchors for the first function to replace that complete function with function renamed() { return 8; }. Keep the second function unchanged. Use ordinary file path plus scope anchors, not a result scope combined with start/end.",
  [
    { tool: "read", args: { path: "task.ts", views: ["ast"] }, contains: "scope-begin-" },
    {
      tool: "replace",
      args: {
        start: /scope-begin-/,
        end: /scope-end-/,
        text: /^function renamed\(\) \{ return 8; \}\n?$/,
      },
      reuse: [reuse(0, "start", "anchor"), reuse(0, "end", "anchor")],
    },
  ],
  {
    files: {
      "task.ts":
        "function first() {\n  const value = 7;\n  return value;\n}\nfunction second() { return 9; }\n",
    },
    expected: { "task.ts": "function renamed() { return 8; }\nfunction second() { return 9; }\n" },
  },
);

add(
  "select-navigate",
  ["select.navigate"],
  "AST-search task.ts for the whole declaration named first, using a wildcard body. Take its exact Search match selection and use select navigate to its next function sibling directly, without an intermediate enclosing selection. Read that returned selection and report the sibling name.",
  [
    { tool: "search", args: { path: "task.ts", query: /ast:/ } },
    {
      tool: "select",
      args: { operation: { kind: "navigate", relation: "siblings", direction: "next" } },
      reuse: reuse(0),
    },
    { tool: "read", reuse: reuse(1), contains: "second" },
  ],
  { files: syntax, answer: "second" },
);

add(
  "select-elementExtent",
  ["select.elementExtent"],
  "Search task.js for the exact digit 2. Select that call argument with elementExtent around, then delete its selection so the call becomes sum(1, 3).",
  [
    {
      tool: "search",
      args: { query: "2" },
      argsAny: [{ path: "task.js" }, { include: "task.js" }],
    },
    {
      tool: "select",
      args: { operation: { kind: "elementExtent", extent: "around" } },
      reuse: reuse(0),
    },
    { tool: "delete", reuse: reuse(1) },
  ],
  { files: { "task.js": "sum(1, 2, 3);\n" }, expected: { "task.js": "sum(1, 3);\n" } },
);

add(
  "codemode-store",
  ["codemode.store-load", "compose.cross-call"],
  "In one Codemode call, read task.txt and store the unchanged result. In a second Codemode call, load it and search within that result for OLD. Pass the resulting Search selection into replace to change OLD to NEW. Do not reread or retype the file path for the dependent operations.",
  [
    { tool: "read", args: { path: "task.txt" } },
    { tool: "search", args: { query: "OLD" }, reuse: { ...reuse(0), newParent: true } },
    { tool: "replace", args: { text: "NEW" }, reuse: reuse(1) },
  ],
  { modes: ["codemode"], expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

add(
  "stale-recovery",
  ["compose.stale-recovery", "read.reference-recovery"],
  "Read task.txt with anchors. Change OLD to NEW using replace. Try to read the old Read result; it must be rejected as stale. Then read the current file and report NEW. Do not try to revive the old result.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    { tool: "replace", args: { text: "NEW" } },
    { tool: "read", error: true, reuse: reuse(0) },
    { tool: "read", args: { path: "task.txt" }, contains: "NEW" },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" }, answer: "NEW" },
);

add(
  "shell-roundtrip",
  [
    "shell.execute",
    "shell.read",
    "shell.search",
    "shell.input",
    "shell.keys",
    "compose.shell-reference-after-input",
    "shell.file-authority-refusal",
    "shell.delete",
    "process.discovery",
    "process.read",
  ],
  "Start a Bash command that waits for one input line and then prints that line. Use its returned shell resource: write the text hello without Enter, insert the Enter key, read the completed shell, and search its retained output for hello. Attempt to replace hello through the returned terminal Read result and confirm refusal: terminal output grants no file-edit authority. Also discover this Pi process using process: and read its PID resource. Finally delete the shell session. Do not edit files.",
  [
    { tool: "bash", args: { background: true } },
    { tool: "write", args: { content: "hello" }, reuse: reuse(0, "path", "shell") },
    { tool: "insert", args: { text: "Enter" }, reuse: reuse(0, "path", "shell") },
    { tool: "read", reuse: reuse(0, "path", "shell"), contains: "hello" },
    {
      tool: "replace",
      args: { start: "hello", text: "BAD" },
      reuse: reuse(3),
      error: true,
    },
    {
      tool: "search",
      args: { query: "hello" },
      reuse: reuse(0, "path", "shell"),
      contains: "hello",
    },
    { tool: "search", args: { query: /process:/ } },
    { tool: "read", args: { path: /process:\d+/ } },
    { tool: "delete", reuse: reuse(0, "path", "shell") },
  ],
  { answer: "hello" },
);

add(
  "shell-screen",
  ["shell.image", "shell.sequence"],
  "Start a completed Bash command that prints SCREEN-MARKER. Capture its shell resource with the image view and then with a short sequence view. Report the printed marker. Do not edit files.",
  [
    { tool: "bash", args: { command: /SCREEN-MARKER/ } },
    { tool: "read", args: { views: ["image"] }, reuse: reuse(0, "path", "shell"), image: true },
    { tool: "read", args: { views: [/sequence/] }, reuse: reuse(0, "path", "shell"), image: true },
  ],
  { answer: "SCREEN-MARKER" },
);

add(
  "debug-roundtrip",
  [
    "debug.create",
    "debug.read",
    "debug.breakpoints",
    "debug.start",
    "debug.evaluate",
    "debug.delete",
    "discovery.debug",
  ],
  "Discover debug and create a debugpy session for task.py. Read its source with anchors, place a breakpoint on the print line using insert breakpoint, and start the debugger. When stopped, evaluate value with insert evaluate value. Read the stopped session, report value=42, then delete the debugger session. Source must stay unchanged.",
  [
    { tool: "debug", args: { adapter: "debugpy", program: "task.py" } },
    { tool: "read", args: { path: /debug:.*\/source/, views: ["anchors"] } },
    {
      tool: "insert",
      args: { path: /debug:.*\/source/, text: "breakpoint" },
      reuse: reuse(1, "anchor", "anchor"),
    },
    { tool: "insert", args: { text: "start" }, reuse: reuse(0, "path", "debug") },
    {
      tool: "insert",
      args: { text: "evaluate value" },
      reuse: reuse(0, "path", "debug"),
      contains: "42",
    },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    { tool: "delete", reuse: reuse(0, "path", "debug") },
  ],
  {
    files: { "task.py": "value = 42\nprint(value)\n" },
    answer: "42",
    prerequisite: "python3 -c 'import debugpy'",
  },
);

add(
  "debug-controls",
  [
    "debug.step-into",
    "debug.step-over",
    "debug.step-out",
    "debug.continue",
    "debug.delete-breakpoint",
    "read.breakpoints",
  ],
  "Discover debug and create a debugpy session for task.py. Read its source with anchors and place a breakpoint on the answer assignment. Read the source again with the breakpoints view. Start, then step into the twice function, step over its first assignment, and evaluate result while stopped. Step out, read the stopped session, delete the returned breakpoint resource, continue to completion, read the completed session, and delete the session. Read stopped state before each next control action. Report the evaluated result. Do not change source files.",
  [
    { tool: "debug", args: { adapter: "debugpy", program: "task.py" } },
    { tool: "read", args: { path: /debug:.*\/source/, views: ["anchors"] } },
    {
      tool: "insert",
      args: { path: /debug:.*\/source/, text: "breakpoint" },
      reuse: reuse(1, "anchor", "anchor"),
    },
    { tool: "read", args: { path: /debug:.*\/source/, views: ["breakpoints"] }, contains: "twice" },
    { tool: "insert", args: { text: "start" }, reuse: reuse(0, "path", "debug") },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    { tool: "insert", args: { text: "step into" }, reuse: reuse(0, "path", "debug") },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    { tool: "insert", args: { text: "step over" }, reuse: reuse(0, "path", "debug") },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    {
      tool: "insert",
      args: { text: "evaluate result" },
      reuse: reuse(0, "path", "debug"),
      contains: "42",
    },
    { tool: "insert", args: { text: "step out" }, reuse: reuse(0, "path", "debug") },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    { tool: "delete", reuse: reuse(2, "path", "breakpoint") },
    { tool: "insert", args: { text: "continue" }, reuse: reuse(0, "path", "debug") },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    { tool: "delete", reuse: reuse(0, "path", "debug") },
  ],
  {
    files: {
      "task.py":
        "def twice(value):\n    result = value * 2\n    return result\n\nvalue = 21\nanswer = twice(value)\nprint(answer)\n",
    },
    answer: "42",
    prerequisite: "python3 -c 'import debugpy'",
  },
);

add(
  "lsp-read",
  ["lsp.symbols", "lsp.references", "lsp.graph", "lsp.diagnostics", "read.diagnostics-view"],
  "Use symbol search on task.ts to find count, then search that returned result with navigation references to find its usage. Read the symbol declaration and call graph. Read diagnostics:problem.ts and also read problem.ts with the diagnostics view; wait for the actual TypeScript error report, not a pending/unavailable status. Report the declared count value and diagnostic code. Do not change files.",
  [
    { tool: "search", args: { path: "task.ts", query: /symbols:count/ }, contains: "count" },
    {
      tool: "search",
      args: { query: /symbols:count/, navigation: "references" },
      reuse: reuse(0),
      contains: "count",
    },
    { tool: "read", args: { path: /symbol:task.ts#.*count/ }, contains: "3" },
    { tool: "read", args: { path: /^graph:task.ts(?:#.*)?$/ }, contains: "References" },
    {
      tool: "read",
      args: { path: "diagnostics:problem.ts" },
      contains: "typescript-language-server:2322",
    },
    {
      tool: "read",
      args: { path: "problem.ts", views: ["diagnostics"] },
      contains: "typescript-language-server:2322",
    },
  ],
  {
    files: {
      "task.ts": "export const count = 3;\nexport const doubled = count * 2;\n",
      "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true},"include":["*.ts"]}\n',
      "problem.ts": 'export function broken(): number {\n  return "diagnostic";\n}\n',
      ".pi/pi-agent-ide/extensions.json": '{"flags":{"pi-agent-ide-no-diagnostic-buffer":true}}\n',
    },
    answer: "3",
    prerequisite: "command -v typescript-language-server",
  },
);

add(
  "lsp-rename",
  ["lsp.rename", "compose.symbol-read-rename"],
  "First read the symbol declaration for count in task.ts and wait until it resolves. Then use replace on its symbol name resource to rename it to total through LSP. Both the declaration and its usage must change. Do not do an ordinary text replacement.",
  [
    { tool: "read", args: { path: /symbol:task.ts#.*count/ }, contains: "count" },
    { tool: "replace", args: { path: /symbol:task.ts#.*count#name/, text: "total" } },
  ],
  {
    files: {
      "task.ts": "export const count = 3;\nexport const doubled = count * 2;\n",
      "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["task.ts"]}\n',
    },
    expected: { "task.ts": "export const total = 3;\nexport const doubled = total * 2;\n" },
    prerequisite: "command -v typescript-language-server",
  },
);

add(
  "read-media",
  ["read.image", "read.pdf"],
  "Use read to inspect sample.png and sample.pdf. Report the text marker inside the PDF. Do not change files.",
  [
    { tool: "read", args: { path: "sample.png" }, image: true },
    { tool: "read", args: { path: "sample.pdf" }, contains: "PDF-MARKER" },
  ],
  { files: {}, answer: "PDF-MARKER", setup: "media" },
);

add(
  "web-read-search",
  ["web.read", "web.search", "web.image", "web.sequence"],
  "The local fixture server is at http://127.0.0.1:8765. Read its page, search that URL for WEB-MARKER, then read the page as an image and as a short sequence. Report the page marker. Do not change files.",
  [
    { tool: "read", args: { path: "http://127.0.0.1:8765" }, contains: "WEB-MARKER" },
    {
      tool: "search",
      args: { path: "http://127.0.0.1:8765", query: "WEB-MARKER" },
      contains: "WEB-MARKER",
    },
    { tool: "read", args: { path: "http://127.0.0.1:8765", views: ["image"] }, image: true },
    { tool: "read", args: { path: "http://127.0.0.1:8765", views: [/sequence/] }, image: true },
  ],
  {
    files: {},
    answer: "WEB-MARKER",
    setup: "web",
    prerequisite: "command -v google-chrome || command -v chromium",
  },
);

add(
  "vision-display-window",
  ["vision.display", "vision.window", "vision.sequence"],
  "A sandbox-only display and a window titled CAPABILITY-WINDOW are running. Discover the window process with process: search, read its window:PID capture, then capture display: as an image and short sequence. Report the visible window title. Do not inspect host windows or change files.",
  [
    { tool: "search", args: { query: /process:/ } },
    { tool: "read", args: { path: /window:\d+/ }, image: true },
    { tool: "read", args: { path: "display:", views: ["image"] }, image: true },
    { tool: "read", args: { path: "display:", views: [/sequence/] }, image: true },
  ],
  {
    files: {},
    answer: "CAPABILITY-WINDOW",
    setup: "display",
    prerequisite: "command -v Xvfb && command -v xmessage",
  },
);

/** The same small tasks are used for every configured model. */
export const capabilityCases: CapabilityCase[] = cases;
