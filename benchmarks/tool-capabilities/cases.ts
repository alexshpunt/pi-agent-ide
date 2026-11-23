import { pixelPng } from "./sandbox.ts";
import { parallelCalls } from "./prompts.ts";
import type { CapabilityCase, RouteStep } from "./validation.ts";

// Directory/symlink approval is a host UI policy, not an agent calling requirement.
const both = ["direct", "codemode"];
const reuse = (from: number, field: string | string[] = "path", kind = "result") => ({
  from,
  field,
  kind,
});
/**
 * A numbered Search `:match` reference of a direct call, or in Codemode the id of a match from a
 * Search value, which carries no numbered references.
 */
const matchReference = (index: number) =>
  new RegExp(`^(?:SEARCH#[A-F0-9]+:${String(index)}:match|RESULT#[a-f\\d-]{36})$`, "u");
const textFile = { "task.txt": "keep\nOLD\nlast\n" };
const deleteFixture = { "sentinel.txt": "KEEP\n", "tracked/data": "KEEP\n" };
const cases: CapabilityCase[] = [];

add(
  "codemode-tool-names",
  ["codemode.provider-tool-names"],
  'Use one native Codemode script to Read task.txt. Wait for that Read result so it captures OLD before any edit. Replace the literal OLD fragment with NEW, and pass the unchanged returned mutation value as the path argument to Read. Print both Read values. Then Write note.txt with exactly "saved\\n", run Bash with command "printf tool-name-probe", and print its output. Keep every other byte. Report the probe output and the final task.txt content.',
  [
    { tool: "read", args: { path: "task.txt" }, contains: "OLD", parentContains: "OLD" },
    { tool: "replace", args: { path: "task.txt" }, exactText: ["at"], after: [0] },
    { tool: "read", reuse: reuse(1), contains: "NEW", parentContains: "NEW" },
    { tool: "write", args: { path: "note.txt" } },
    { tool: "bash", contains: "tool-name-probe", parentContains: "tool-name-probe" },
  ],
  {
    modes: ["codemode"],
    expected: { "task.txt": "keep\nNEW\nlast\n", "note.txt": "saved\n" },
    answer: "tool-name-probe",
  },
);

for (const selection of ["numbered", "all"] as const) {
  add(
    `search-compaction-${selection}`,
    [`search.compaction-${selection}`],
    selection === "numbered"
      ? "Search task.txt for OLD with limit 1. After that Search returns the compact group of three identical lines, repeat the same Search on task.txt with limit 3 to obtain all three individual references. Then Insert ADDED after each of those three lines using its own actual issued numbered SEARCH :line reference as path; omit after and before. Use text ADDED followed by a newline. Keep every other byte. Do not reuse the first reference for the other occurrences."
      : "Search task.txt for OLD with limit 1. The three identical lines are compacted. Use that completed Search's actual issued :all:line reference as path in one Insert call with text ADDED followed by a newline and no selector. Insert once after each OLD line and keep every other byte. Do not use the compact group's first numbered reference.",
    [
      { tool: "search", args: { path: "task.txt", query: "OLD", limit: 1 } },
      ...(selection === "numbered"
        ? [
            { tool: "search", args: { path: "task.txt", query: "OLD", limit: 3 }, after: [0] },
            ...[1, 2, 3].map((index): RouteStep => ({
              tool: "insert",
              args: {
                path: new RegExp(`^SEARCH#[A-F0-9]+:${index}:line$`, "u"),
                text: "ADDED\n",
              },
              reuse: reuse(1),
            })),
          ]
        : [
            {
              tool: "insert",
              args: { path: /^SEARCH#[A-F0-9]+:all:line$/u, text: "ADDED\n" },
              reuse: reuse(0),
            },
          ]),
    ],
    {
      modes: ["direct"],
      files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\nOLD\n" },
      expected: { "task.txt": "keep1\nOLD\nADDED\nkeep2\nOLD\nADDED\nkeep3\nOLD\nADDED\n" },
    },
  );
}
add(
  "missing-edit-selector-recovery",
  ["edit.missing-selector-recovery"],
  'Exercise two independent recovery chains; neither chain needs to wait for the other. In the Insert chain, call insert on task.txt with text "added" and neither after nor before; it must fail without editing. After that refusal returns, Read task.txt. Wait for that Read result before retrying insert with after "OLD" and the same text. In the Copy chain, call copy from source.txt to target.txt, passing the literal string "OLD" as at and omitting targetAfter; it must fail without editing either file. After that refusal returns, Read target.txt. Wait for that Read result before retrying copy with targetAfter "DEST". Keep all existing lines. Do not use whole-file operations or write. In Codemode, keep going after each refused call using the returned null and the failure summary.',
  [
    {
      tool: "insert",
      args: { path: "task.txt", after: undefined, before: undefined, text: /[\s\S]+/u },
      error: true,
      contains: "INVALID_REQUEST",
    },
    { tool: "read", args: { path: "task.txt" }, after: [0] },
    { tool: "insert", args: { path: "task.txt", after: "OLD", text: "added" }, after: [1] },
    {
      tool: "copy",
      args: {
        path: "source.txt",
        target: "target.txt",
        targetAt: undefined,
        targetFrom: undefined,
        targetAfter: undefined,
        targetThrough: undefined,
        targetBefore: undefined,
      },
      exactText: ["at"],
      error: true,
      contains: "INVALID_REQUEST",
    },
    { tool: "read", args: { path: "target.txt" }, after: [3] },
    {
      tool: "copy",
      args: { path: "source.txt", at: "OLD", target: "target.txt", targetAfter: "DEST" },
      after: [4],
    },
  ],
  {
    modes: both,
    files: { ...textFile, "source.txt": "OLD\n", "target.txt": "DEST\n" },
    // LPT-1747: single-line Insert stays inline, while Copy of a whole line inserts a line.
    expected: { "task.txt": "keep\nOLDadded\nlast\n", "target.txt": "DEST\nOLD\n" },
  },
);
add(
  "codemode-search-value-batch",
  ["compose.codemode-search-value-batch"],
  "In native Codemode, Search task.txt for beta and retain the returned value. Then in one script run the three independent edits concurrently with Promise.all, without any other tool between them: Insert a new line before alpha in task.txt with text added followed by a newline; Replace beta by passing the first Search match value as path, with BETA; Delete the whole gamma line, including its line break, in task.txt by passing a literal string as at. Keep omega. Reuse the native Search match value or its id without extracting textual SEARCH anchors. All three edits must belong to one committed editor batch.",
  [
    { tool: "search", args: { path: "task.txt", query: "beta" } },
    {
      tool: "insert",
      args: { path: "task.txt", before: /[\s\S]+/u, after: undefined },
      editorBatchSize: 3,
    },
    {
      tool: "replace",
      reuse: reuse(0),
      sameAssistantWith: 1,
      editorBatchSize: 3,
    },
    {
      tool: "delete",
      args: { path: "task.txt" },
      exactText: ["at"],
      sameAssistantWith: 2,
      editorBatchSize: 3,
    },
  ],
  {
    modes: ["codemode"],
    files: { "task.txt": "alpha\nbeta\ngamma\nomega\n" },
    expected: { "task.txt": "added\nalpha\nBETA\nomega\n" },
  },
);
add(
  "codemode-search-anchor-batch",
  ["compose.codemode-search-anchor-batch"],
  "In native Codemode, Search task.txt for regex:beta|gamma. The fixture retains that Search's unchanged readable output in .pi/issued-search.txt because script values expose RESULT ids, not SEARCH anchors. Use tools.read inside Codemode to Read .pi/issued-search.txt and extract the actual issued numbered SEARCH :line references for beta and gamma, ending in :line, not :match. Then in one script run these three independent edits concurrently with Promise.all, without Read/Search or another tool between them: Insert a new line before alpha in task.txt with text added followed by a newline; Replace the beta line using its issued SEARCH reference as at, omitting path, with BETA followed by a newline; Delete gamma using its issued SEARCH reference as at, omitting path. Keep omega. Do not use RESULT ids or fabricate Search session ids. All three edits must belong to one committed editor batch.",
  [
    { tool: "search", args: { path: "task.txt", query: "regex:beta|gamma" } },
    { tool: "read", args: { path: ".pi/issued-search.txt" } },
    {
      tool: "insert",
      args: { path: "task.txt", before: /[\s\S]+/u, after: undefined },
      editorBatchSize: 3,
    },
    {
      tool: "replace",
      args: { path: undefined, at: /^SEARCH#[A-F0-9]+:1:line$/u },
      reuse: reuse(0, "at"),
      sameAssistantWith: 2,
      editorBatchSize: 3,
    },
    {
      tool: "delete",
      args: { path: undefined, at: /^SEARCH#[A-F0-9]+:2:line$/u },
      reuse: reuse(0, "at"),
      sameAssistantWith: 3,
      editorBatchSize: 3,
    },
  ],
  {
    modes: ["codemode"],
    setup: "native-search-batch",
    files: { "task.txt": "alpha\nbeta\ngamma\nomega\n" },
    expected: { "task.txt": "added\nalpha\nBETA\nomega\n" },
  },
);
add(
  // Use a fresh session to exercise discovery before direct calls.
  "deferred-navigation-recovery",
  ["discovery.ast-search", "discovery.lsp-search", "discovery.diff", "discovery.undo"],
  'In direct mode, discover ast_search, lsp_search, diff and undo through tool_search before using them. In Codemode, call the named tools through tools without loading them first. Use ast_search to find probe($ARG) in task.ts and lsp_search to find the symbol probe. Compare task.ts with itself using diff with the literal path strings before: "task.ts" and after: "task.ts"; in Codemode its value must be an empty string. Replace OLD with NEW in task.txt. Wait for the Replace result before using undo with change: "last" to revert that edit. After the Undo result returns, Read task.txt and report its restored marker. Preserve both files.',
  [
    {
      tool: "tool_search",
      discovers: ["ast_search", "lsp_search", "diff", "undo"],
    },
    { tool: "ast_search", args: { path: "task.ts", pattern: "probe($ARG)" }, contains: "probe(1)" },
    { tool: "lsp_search", args: { query: "probe" }, contains: "task.ts#probe" },
    { tool: "diff", args: { before: "task.ts", after: "task.ts" }, scriptResult: "" },
    { tool: "replace", args: { path: "task.txt", text: "NEW" } },
    { tool: "undo", args: { change: "last" }, after: [4] },
    { tool: "read", args: { path: "task.txt" }, contains: "OLD", after: [5] },
  ],
  {
    files: {
      ...textFile,
      "task.ts": "export function probe(value: number) { return value; }\nprobe(1);\n",
      "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
    },
    expected: {
      ...textFile,
      "task.ts": "export function probe(value: number) { return value; }\nprobe(1);\n",
      "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
    },
    answer: "OLD",
    prerequisite: "command -v typescript-language-server",
  },
);
add(
  "standalone-resource-host",
  [
    "standalone.discovery",
    "standalone.read-search-edit",
    "standalone.resource-bounds",
    "standalone.refusal-classification",
  ],
  "Only standalone resource hosts are loaded; the full IDE is not enabled. In direct mode, discover the demo namespace through tool_search. In Codemode, call the demo tools directly; discovery is optional. Read the first line of memory://demo/note, Search that returned window for alpha, then Replace the returned search selection with changed. Preserve the second line omega. Attempt demo_read on local.txt, demo_read on memory://other/note and demo_copy with path=memory://demo/note and target=local.txt; all must fail without changing local.txt. After the demo_replace result returns, reread memory://demo/note to inspect changed and omega. This reread is independent of the three refused calls. Use demo tools, not the sibling namespace or filesystem tools.",
  [
    {
      tool: "tool_search",
      discovers: ["demo_read", "demo_search", "demo_replace", "demo_copy"],
    },
    {
      tool: "demo_read",
      args: { path: "memory://demo/note", offset: 1, limit: 1 },
      contains: "alpha",
    },
    { tool: "demo_search", args: { query: "alpha" }, reuse: reuse(1), contains: "alpha" },
    { tool: "demo_replace", reuse: reuse(2) },
    {
      tool: "demo_read",
      args: { path: "local.txt" },
      error: true,
      contains: "RESOURCE_HOST_LOCAL_PATH",
    },
    {
      tool: "demo_read",
      args: { path: "memory://other/note" },
      error: true,
      contains: "RESOURCE_HOST_FOREIGN_SOURCE",
    },
    {
      tool: "demo_copy",
      args: { path: "memory://demo/note", target: "local.txt" },
      error: true,
      contains: "RESOURCE_HOST_LOCAL_PATH",
    },
    {
      tool: "demo_read",
      args: { path: "memory://demo/note" },
      contains: "changed\nomega",
      after: [3],
    },
  ],
  {
    setup: "standalone-resource",
    files: {
      "resource.txt": "alpha\nomega\n",
      "other.txt": "sibling\n",
      "local.txt": "local sentinel\n",
    },
    expected: {
      "resource.txt": "changed\nomega\n",
      "other.txt": "sibling\n",
      "local.txt": "local sentinel\n",
    },
  },
);
add(
  "semantic-write-receipts",
  ["edit.semantic-write-receipt"],
  "Use Write once each, in this listed order, on fixture:semantic/applied, fixture:semantic/not-applied and fixture:semantic/unknown with content probe. These are synthetic resource actions, not files. Inspect each provider receipt: preserve the applied, not-applied or unknown effect and its attempted prefix. Never replay a refused or uncertain action. In Codemode a failed call resolves to null, so the remaining distinct actions still run. Report the lowercase word unknown for the uncertain action; do not call it a failed file save.",
  [
    {
      tool: "write",
      args: { path: "fixture:semantic/applied" },
      contains: "Semantic action applied",
      excludes: "Saved file.",
    },
    {
      tool: "write",
      args: { path: "fixture:semantic/not-applied" },
      error: true,
      contains: "Semantic action not-applied",
      excludes: "no file was written",
    },
    {
      tool: "write",
      args: { path: "fixture:semantic/unknown" },
      error: true,
      contains: "Semantic action unknown",
      excludes: "Write outcome unknown.",
    },
  ],
  {
    setup: "semantic-write",
    expected: {
      ...textFile,
      "attempts.jsonl":
        '{"effect":"applied","content":"probe"}\n{"effect":"not-applied","content":"probe"}\n{"effect":"unknown","content":"probe"}\n',
    },
    answer: "unknown",
  },
);
add(
  "semantic-script-receipts",
  ["compose.provider-structured-receipt"],
  'In native Codemode, call Insert once each on fixture:semantic-script/applied, fixture:semantic-script/not-applied and fixture:semantic-script/unknown with the argument text set to exactly "probe" (not "text probe"). These are synthetic actions, not files. Each call must resolve to an object receipt even when the action is refused or unknown. Pass each returned object unchanged to text(receipt), including its unpredictable nonce and attempted prefix. Do not parse the readable summary or invent a receipt. Never replay an action. Report the lowercase word unknown for the uncertain action.',
  ["applied", "not-applied", "unknown"].map((effect) => ({
    tool: "insert",
    args: { path: `fixture:semantic-script/${effect}` },
    error: effect !== "applied",
    contains: `Semantic action ${effect}`,
    parentStructuredValue: true,
    scriptResult: {
      kind: "fixture-action",
      ok: effect === "applied",
      effect,
      receipt: { attempted: 1, delivered: effect !== "not-applied" },
      nonce: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
    },
  })),
  {
    modes: ["codemode"],
    setup: "semantic-write",
    expected: {
      ...textFile,
      "attempts.jsonl":
        '{"effect":"applied","text":"probe"}\n{"effect":"not-applied","text":"probe"}\n{"effect":"unknown","text":"probe"}\n',
    },
    answer: "unknown",
  },
);
add(
  "parallel-provider-write-queue",
  ["compose.parallel-provider-writes"],
  'In one native Codemode script, call Write three times to fixture://queue/issue/comments/new. Submit all three calls together in one Promise.all, in this order, with content exactly "first", "second", and "third", respectively. Await the batch; do not await any individual call before submitting the others. These are provider actions, not local file writes. Do not retry a call or edit provider-comments.txt yourself.',
  ["first", "second", "third"].map((content, index) => ({
    tool: "write",
    args: { path: "fixture://queue/issue/comments/new", content },
    ...(index > 0 && { parallelWith: 0 }),
  })),
  {
    modes: ["codemode"],
    setup: "parallel-provider-writes",
    files: {},
    expected: { "provider-comments.txt": "first\nsecond\nthird\n" },
    forbiddenTools: ["bash", "insert", "replace", "delete", "copy", "move"],
  },
);
add(
  "ide-settings-catalog",
  ["read.ide-settings", "search.ide-settings"],
  "Read docs:ide-settings with limit 1000 to inspect the registered IDE settings. Find the registered ui.codemode preference. Search that exact ID in docs:ide-settings with caseSensitive true and limit 1000, then repeat the search in docs:all. Both searches must return locations under docs:ide-settings without editable Search references. Do not change configuration or fixture files.",
  [
    {
      tool: "read",
      args: { path: "docs:ide-settings", limit: 1000 },
      contains: "ui.codemode",
    },
    {
      tool: "search",
      args: {
        path: "docs:ide-settings",
        query: "ui.codemode",
        caseSensitive: true,
        limit: 1000,
      },
      contains: "docs:ide-settings:",
      excludes: "SEARCH#",
    },
    {
      tool: "search",
      args: {
        path: "docs:all",
        query: "ui.codemode",
        caseSensitive: true,
        limit: 1000,
      },
      contains: "docs:ide-settings:",
      excludes: "SEARCH#",
    },
  ],
  { expected: textFile },
);
add(
  "docs-search",
  [
    "search.docs-all",
    "search.docs-one",
    "search.docs-flags",
    "search.docs-readonly",
    "search.docs-literal-colon",
  ],
  "Read docs:terminal. Search docs:terminal with query terminal, caseSensitive true, wholeWord true and limit 10. The result must contain guide-body locations under docs:terminal, not editable Search references. Search docs:terminal again with the literal query shell: and confirm a match under docs:terminal. Then Search path docs:all with query regex:^# and limit 1000. Confirm it finds docs:terminal body headings rather than just the guide listing. Do not change files.",
  [
    { tool: "read", args: { path: "docs:terminal" } },
    {
      tool: "search",
      args: {
        path: "docs:terminal",
        query: "terminal",
        caseSensitive: true,
        wholeWord: true,
        limit: 10,
      },
      contains: "docs:terminal:",
      excludes: "SEARCH#",
    },
    {
      tool: "search",
      args: { path: "docs:terminal", query: "shell:" },
      contains: "docs:terminal:",
      excludes: "SEARCH#",
    },
    {
      tool: "search",
      args: { path: "docs:all", query: "regex:^#", limit: 1000 },
      contains: "docs:terminal:",
      excludes: "RESULT#",
    },
  ],
  { expected: textFile },
);
add(
  "docs-search-status",
  ["search.docs-limit", "search.docs-empty", "search.docs-unknown", "search.docs-bare"],
  "Search all guide bodies with path docs:all, query regex:., and limit 1; the result must report incomplete coverage. Search docs:terminal with query regex:(?!) and confirm a successful empty result. Search path docs: with query regex:. and observe an error directing you to docs:all. Finally Search path docs:lpt-723-missing with query regex:. and observe an unknown-documentation-ID error, not a filesystem search or zero matches. In Codemode the failed call resolves to null. Do not change files.",
  [
    {
      tool: "search",
      args: { path: "docs:all", query: "regex:.", limit: 1 },
      contains: "incomplete",
    },
    {
      tool: "search",
      args: { path: "docs:terminal", query: "regex:(?!)" },
      contains: "No matches",
    },
    { tool: "search", args: { path: "docs:" }, error: true, contains: "Use docs:all" },
    {
      tool: "search",
      args: { path: "docs:lpt-723-missing" },
      error: true,
      contains: "Unknown documentation ID: lpt-723-missing",
    },
  ],
  { expected: textFile },
);
add(
  "ssh-guide",
  ["read.ssh-guide"],
  "The workspace has no configured SSH targets. Read docs:ssh through Read and report the os value and absolute workspace shape for a native Windows target. Do not open a connection or change any settings.",
  [{ tool: "read", args: { path: "docs:ssh" }, contains: "C:/Users/name" }],
  { answer: "windows" },
);
add(
  "delete-objects",
  ["edit.delete-directory", "edit.delete-symlink", "edit.delete-broken-symlink"],
  "Delete remove-tree recursively, then unlink link and broken-link using ordinary paths without text selectors. Leave sentinel.txt and tracked/data untouched.",
  [
    { tool: "delete", args: { path: "remove-tree" }, contains: "delete: applied" },
    { tool: "delete", args: { path: "link" }, contains: "delete: applied" },
    { tool: "delete", args: { path: "broken-link" }, contains: "delete: applied" },
  ],
  {
    files: deleteFixture,
    git: true,
    setup: "delete-objects",
    expected: {
      "remove-tree": null,
      "remove-tree/data": null,
      "remove-tree/link": null,
      "remove-tree/nested/data.bin": null,
      "remove-tree/broken": null,
      link: null,
      "broken-link": null,
    },
  },
);
add(
  "filesystem-yolo",
  ["edit.approval-yolo-delete", "edit.approval-yolo-move", "compose.yolo-protected-target"],
  "This fixture explicitly enables filesystem YOLO. Delete the tracked directory delete-tree and Move the tracked directory move-tree to moved-tree without a user UI. YOLO skips approval only: deleting .git/config must still be refused. Read moved-tree/data to confirm MOVE. In Codemode the protected-target refusal resolves to null and the read still runs.",
  [
    { tool: "delete", args: { path: "delete-tree" }, contains: "delete: applied" },
    { tool: "move", args: { path: "move-tree", target: "moved-tree" }, contains: "move: applied" },
    {
      tool: "delete",
      args: { path: ".git/config" },
      error: true,
      contains: "DELETE_PROTECTED_TARGET",
    },
    { tool: "read", args: { path: "moved-tree/data" }, contains: "MOVE" },
  ],
  {
    files: {
      "delete-tree/data": "DELETE\n",
      "move-tree/data": "MOVE\n",
      ".pi/pi-agent-ide/extensions.json": JSON.stringify({
        flags: { "pi-agent-ide-filesystem-yolo": true },
      }),
    },
    git: true,
    expected: {
      "delete-tree": null,
      "delete-tree/data": null,
      "move-tree": null,
      "move-tree/data": null,
      "moved-tree/data": "MOVE\n",
    },
  },
);
add(
  "delete-policy-gates",
  [
    "edit.delete-policy-refusal",
    "edit.delete-protected-path",
    "edit.delete-protected-root",
    "edit.approval-headless-delete",
    "compose.approval-refusal-read",
  ],
  "Use Delete on these exact paths, each as a whole object: the directory tracked itself (path tracked, not a file inside it), .git/config, the current directory (.), and filesystem root (/). All must be blocked in this non-interactive runtime. Deleting a directory with Git-tracked entries requires a host approval dialog; there is no user UI here, so it must fail closed rather than treating the prompt as permission. Then Read tracked/data and check its unchanged KEEP content. Keep all fixture bytes unchanged and report the refusal reasons. In Codemode each refusal resolves to null and the following calls still run.",
  [
    {
      tool: "delete",
      args: { path: "tracked" },
      error: true,
      contains: "DELETE_CONFIRMATION_REQUIRED",
    },
    {
      tool: "delete",
      args: { path: ".git/config" },
      error: true,
      contains: "DELETE_PROTECTED_TARGET",
    },
    { tool: "delete", args: { path: "." }, error: true, contains: "DELETE_PROTECTED_TARGET" },
    { tool: "delete", args: { path: "/" }, error: true, contains: "DELETE_PROTECTED_TARGET" },
    { tool: "read", args: { path: "tracked/data" }, contains: "KEEP" },
  ],
  { files: deleteFixture, git: true },
);
add(
  "directory-transfers",
  [
    "edit.copy-directory",
    "edit.move-directory",
    "edit.copy-symlink",
    "edit.move-symlink",
    "edit.copy-merge-directory",
    "edit.move-replace-directory",
    "compose.object-transfer-refusal",
  ],
  "Copy source-tree into merge-target, retaining copy-only and overwriting nested/data.bin. Move merge-target onto moved-target, removing move-only. Copy then move standalone link and broken-link to moved-link and moved-broken through temporary copied-link and copied-broken paths. Use ordinary paths with no text selectors. Preserve all link text without following targets. Read moved-target/nested/empty to check the empty directory exists. With direct calls, Search the unchanged first Copy result for BAD and observe that it has no reusable text selection. In Codemode that Copy resolves to null because it selects no text; skip that Search. Keep source-tree, link, broken-link, sentinel.txt, and tracked/data unchanged.",
  [
    {
      tool: "copy",
      args: { path: "source-tree", target: "merge-target" },
      contains: "copy: applied",
    },
    {
      tool: "move",
      args: { path: "merge-target", target: "moved-target" },
      contains: "move: applied",
    },
    { tool: "copy", args: { path: "link", target: "copied-link" }, contains: "copy: applied" },
    {
      tool: "move",
      args: { path: "copied-link", target: "moved-link" },
      contains: "move: applied",
    },
    {
      tool: "copy",
      args: { path: "broken-link", target: "copied-broken" },
      contains: "copy: applied",
    },
    {
      tool: "move",
      args: { path: "copied-broken", target: "moved-broken" },
      contains: "move: applied",
    },
    { tool: "read", args: { path: "moved-target/nested/empty" } },
    {
      tool: "search",
      reuse: reuse(0),
      error: true,
      contains: "no reusable text selection",
      // A Codemode script gets null for this Copy, so only a direct route can search its result.
      modes: ["direct"],
    },
  ],
  {
    files: deleteFixture,
    git: true,
    setup: "directory-transfers",
    expected: {
      "merge-target": null,
      "copied-link": null,
      "copied-broken": null,
      "merge-target/nested/data.bin": null,
      "merge-target/copy-only": null,
      "moved-target/move-only": null,
      "moved-target/nested/data.bin": "\0\n",
      "moved-target/copy-only": "KEEP\n",
      "moved-target/link": "symlink:/workspace/fixture/sentinel.txt",
      "moved-target/broken": "symlink:missing",
      "moved-link": "symlink:sentinel.txt",
      "moved-broken": "symlink:missing",
    },
  },
);
add(
  "directory-transfer-gates",
  [
    "edit.transfer-refusal",
    "edit.move-policy-refusal",
    "edit.approval-headless-move",
    "compose.approval-refusal-read",
  ],
  "Use Copy on source-tree to source-tree/new; it must refuse overlap. Use Copy from source-tree to link; it must refuse a symlink destination. Use Move on tracked to new-target; it must require a host approval dialog and fail closed in this non-interactive runtime. Use Move from source-tree to .git; it must refuse protected Git data. Then Read tracked/data in its own later call to check unchanged KEEP content; new-target must not exist. For the Codemode route, run the Copy and Move calls inside Codemode, inspect their final parent results, then call tools.read in its own later Codemode call. Keep any extra inspection inside Codemode. Each failed child resolves to null, so all checks still run. Report the refusals and leave all fixture bytes unchanged.",
  [
    {
      tool: "copy",
      args: { path: "source-tree", target: "source-tree/new" },
      error: true,
      contains: "OVERLAPPING_PATHS",
    },
    {
      tool: "copy",
      args: { path: "source-tree", target: "link" },
      error: true,
      contains: "INVALID_FILE_TYPE",
    },
    {
      tool: "move",
      args: { path: "tracked", target: "new-target" },
      error: true,
      contains: "DELETE_CONFIRMATION_REQUIRED",
    },
    {
      tool: "move",
      args: { path: "source-tree", target: ".git" },
      error: true,
      contains: "DELETE_PROTECTED_TARGET",
    },
    { tool: "read", args: { path: "tracked/data" }, contains: "KEEP" },
  ],
  {
    files: deleteFixture,
    git: true,
    setup: "directory-transfers",
    expected: { "new-target": null },
  },
);
add(
  "parallel-directory-transfer-gates",
  ["compose.parallel-object-transfer-refusals"],
  (api) =>
    `${parallelCalls(api, 4)} Copy source-tree to source-tree/new (overlap refusal); Copy source-tree to link (symlink destination refusal); Move tracked to new-target (approval unavailable in this non-interactive runtime); Move source-tree to .git (protected Git data refusal). Do not submit these four calls sequentially or retry them. After all four refusals, Read tracked/data to check unchanged KEEP content. Leave every fixture byte unchanged; new-target and source-tree/new must not exist.`,
  [
    {
      tool: "copy",
      args: { path: "source-tree", target: "source-tree/new" },
      error: true,
      contains: "OVERLAPPING_PATHS",
    },
    {
      tool: "copy",
      args: { path: "source-tree", target: "link" },
      sameAssistantWith: 0,
      error: true,
      contains: "INVALID_FILE_TYPE",
    },
    {
      tool: "move",
      args: { path: "tracked", target: "new-target" },
      sameAssistantWith: 0,
      error: true,
      contains: "DELETE_CONFIRMATION_REQUIRED",
    },
    {
      tool: "move",
      args: { path: "source-tree", target: ".git" },
      sameAssistantWith: 0,
      error: true,
      contains: "DELETE_PROTECTED_TARGET",
    },
    { tool: "read", args: { path: "tracked/data" }, contains: "KEEP", after: [0, 1, 2, 3] },
  ],
  {
    modes: ["direct"],
    files: deleteFixture,
    git: true,
    setup: "directory-transfers",
    expected: { "new-target": null, "source-tree/new": null },
  },
);
add(
  "delete-temporary-defaults",
  ["edit.delete-temporary-defaults", "edit.delete-temporary-roots", "edit.delete-temporary-names"],
  "Delete nested/tmp/scratch, nested/.tmp/scratch, nested/temp/scratch, and nested/.temp/scratch through ordinary Delete paths. Then delete each named root itself: nested/tmp, nested/.tmp, nested/temp, and nested/.temp. This workspace has no Git; exact temporary path components need no approval. Leave sentinel.txt unchanged.",
  [
    ...["tmp", ".tmp", "temp", ".temp"].map((name) => ({
      tool: "delete",
      args: { path: `nested/${name}/scratch` },
      contains: "delete: applied",
    })),
    ...["tmp", ".tmp", "temp", ".temp"].map((name) => ({
      tool: "delete",
      args: { path: `nested/${name}` },
      contains: "delete: applied",
    })),
  ],
  {
    setup: "delete-temporary-no-git",
    files: {
      "sentinel.txt": "KEEP\n",
      ...Object.fromEntries(
        ["tmp", ".tmp", "temp", ".temp"].flatMap((name) => [
          [`nested/${name}/scratch/data`, "REMOVE\n"],
          [`nested/${name}/root-data`, "REMOVE\n"],
        ]),
      ),
    },
    expected: Object.fromEntries(
      ["tmp", ".tmp", "temp", ".temp"].flatMap((name) => [
        [`nested/${name}`, null],
        [`nested/${name}/scratch`, null],
        [`nested/${name}/scratch/data`, null],
        [`nested/${name}/root-data`, null],
      ]),
    ),
  },
);
add(
  "delete-temporary-config",
  ["edit.delete-temporary-config", "edit.move-temporary-config"],
  'Delete the directory custom itself (path custom). The project deletion setting replaces the default temporary roots with this custom directory. Then Delete nested/tmp, and Move nested/tmp with target: "moved": nested/tmp is no longer temporary, so both must require approval unavailable in this non-interactive runtime. Leave nested/tmp/data and sentinel.txt unchanged. In Codemode the expected refusals resolve to null.',
  [
    { tool: "delete", args: { path: "custom" }, contains: "delete: applied" },
    {
      tool: "delete",
      args: { path: "nested/tmp" },
      error: true,
      contains: "DELETE_CONFIRMATION_REQUIRED",
    },
    {
      tool: "move",
      args: { path: "nested/tmp", target: "moved" },
      error: true,
      contains: "DELETE_CONFIRMATION_REQUIRED",
    },
  ],
  {
    setup: "delete-temporary-no-git",
    files: {
      ".pi/pi-agent-ide/deletion.json": JSON.stringify({
        temporaryDirectories: { mode: "replace", paths: ["custom"] },
      }),
      "custom/data": "REMOVE\n",
      "nested/tmp/data": "KEEP\n",
      "sentinel.txt": "KEEP\n",
    },
    expected: { custom: null, "custom/data": null, moved: null },
  },
);
add(
  "move-temporary-directories",
  ["edit.move-temporary-defaults", "edit.copy-temporary-directory"],
  "Move nested/tmp over nested/temp, replacing its old contents without an approval dialog. Then Copy nested/temp into nested/.tmp, preserving the destination-only copy-only file. Use ordinary directory paths. This workspace has no Git; temporary roots and descendants are eligible. Leave sentinel.txt unchanged.",
  [
    {
      tool: "move",
      args: { path: "nested/tmp", target: "nested/temp" },
      contains: "move: applied",
    },
    {
      tool: "copy",
      args: { path: "nested/temp", target: "nested/.tmp" },
      contains: "copy: applied",
    },
  ],
  {
    setup: "delete-temporary-no-git",
    files: {
      "nested/tmp/data": "MOVE\n",
      "nested/temp/old": "REMOVE\n",
      "nested/.tmp/copy-only": "KEEP\n",
      "sentinel.txt": "KEEP\n",
    },
    expected: {
      "nested/tmp": null,
      "nested/tmp/data": null,
      "nested/temp/old": null,
      "nested/temp/data": "MOVE\n",
      "nested/.tmp/data": "MOVE\n",
    },
  },
);
function add(
  id: string,
  capabilities: string[],
  prompt: string | NonNullable<CapabilityCase["promptForApi"]>,
  steps: RouteStep[],
  extras: Partial<CapabilityCase> = {},
): void {
  cases.push({
    id,
    capabilities,
    prompt: typeof prompt === "function" ? prompt() : prompt,
    ...(typeof prompt === "function" && { promptForApi: prompt }),
    steps,
    modes: both,
    files: textFile,
    ...extras,
  });
}

add(
  "search-script-facts",
  [
    "search.script-facts",
    "compose.search-script-result",
    "ast.script-line-text",
    "codemode.failed-call-null",
    "codemode.failed-call-summary",
  ],
  "Use native Codemode to Search task.txt for regex:^ABSENT$ and confirm complete coverage with no matches. Replace that empty Search value with BAD; it must succeed without changes. ast_search scope.ts for probe($ARG) with limit 1, then Search that bounded result for regex:^ABSENT$. Confirm that the resulting empty Search is incomplete. Replace that incomplete value with BAD; the call must fail and resolve to null while the script continues. Also Replace in task.txt with the complete empty Search id as at and text BAD; this invalid endpoint must fail and resolve to null. Search task.txt for invalid regex:(, then for OLD with limit 1000. Check matches and complete instead of parsing display prose. Pass the final complete Search value unchanged to Replace with NEW, replacing all its matches and preserving keep/last. Report the facts and keep the failed calls visible in the summary without printing all matches.",
  [
    {
      tool: "search",
      args: { path: "task.txt", query: "regex:^ABSENT$" },
      scriptResult: { complete: true, matches: { length: 0 } },
    },
    { tool: "replace", reuse: reuse(0) },
    {
      tool: "ast_search",
      args: { path: "scope.ts", pattern: "probe($ARG)", limit: 1 },
      scriptResult: {
        complete: false,
        matches: { length: 1, 0: { text: "probe(first)", lineText: "probe(first);" } },
      },
    },
    {
      tool: "search",
      args: { query: "regex:^ABSENT$" },
      reuse: reuse(2),
      scriptResult: { complete: false, matches: { length: 0 } },
    },
    { tool: "replace", reuse: reuse(3), error: true },
    {
      tool: "replace",
      args: { path: "task.txt" },
      reuse: reuse(0, "at"),
      error: true,
    },
    {
      tool: "search",
      args: { path: "task.txt", query: "regex:(" },
      error: true,
    },
    {
      tool: "search",
      args: { path: "task.txt", query: "OLD", limit: 1000 },
      scriptResult: { complete: true, matches: { length: 2 } },
    },
    { tool: "replace", reuse: reuse(7) },
  ],
  {
    modes: ["codemode"],
    files: { "task.txt": "keep\nOLD\nOLD\nlast\n", "scope.ts": "probe(first);\nprobe(second);\n" },
    expected: {
      "task.txt": "keep\nNEW\nNEW\nlast\n",
      "scope.ts": "probe(first);\nprobe(second);\n",
    },
  },
);
add(
  "token-search-edit-guard",
  ["compose.token-search-edit-guard"],
  "Search split.txt for the unquoted query alpha beta. Attempt to Replace the whole broadened selection with BAD (in Codemode use the fallback object); it must fail without changing the file. In Codemode, the failed Replace resolves to null and the script can continue. Then search split.txt for the Boolean query alpha OR beta and replace only its first match with GREEN: pass that Search result as path ({id: its returned UUID} in direct calls, the returned value in Codemode) and its first :match reference as at (the first match value in Codemode). Finally search literal.txt for the same unquoted query alpha beta, which matches there as one phrase, and replace that whole result with LITERAL. Preserve every other byte.",
  [
    { tool: "search", args: { path: "split.txt", query: /^alpha beta$/u } },
    {
      tool: "replace",
      reuse: reuse(0),
      error: true,
      contains: "alpha beta",
    },
    { tool: "search", args: { path: "split.txt", query: "alpha OR beta" } },
    {
      tool: "replace",
      reuse: reuse(2, ["path", "at"]),
    },
    { tool: "search", args: { path: "literal.txt", query: /^alpha beta$/u } },
    {
      tool: "replace",
      reuse: reuse(4, ["path", "at"], "whole-result"),
    },
  ],
  {
    files: { "split.txt": "alpha\nbeta\n", "literal.txt": "alpha beta\n" },
    expected: { "split.txt": "GREEN\nbeta\n", "literal.txt": "LITERAL\n" },
  },
);
add(
  "search-script-fallback",
  ["search.script-fallback"],
  "Use Codemode to search split.txt for alpha beta. Check that the original matches list is empty and complete, and that the word fallback has two matches. Read the first fallback match by its id and report its text. Do not edit the file.",
  [
    {
      tool: "search",
      args: { path: "split.txt", query: "alpha beta" },
      scriptResult: {
        complete: true,
        matches: { length: 0 },
        fallback: { mode: "words", complete: true, matches: { length: 2 } },
      },
    },
    { tool: "read", args: { path: /^RESULT#[a-f\d-]{36}$/u }, reuse: reuse(0) },
  ],
  {
    modes: ["codemode"],
    files: { "split.txt": "alpha\nbeta\n" },
    expected: { "split.txt": "alpha\nbeta\n" },
    answer: "alpha",
  },
);
const rows = Array.from({ length: 150 }, (_, index) => `row ${String(index + 1)}`);
add(
  "search-script-match-ids",
  ["search.script-match-list", "compose.search-match-id"],
  "In one Codemode call, Search list.txt for regex:^row \\d+$. The value must list all 150 matches and be complete, with the last match on line 150. Replace only that last match with LAST by passing that match or its id as Replace's path, not the whole Search value, the file path or a line anchor. Report the number of matches in plain digits.",
  [
    {
      tool: "search",
      args: { path: "list.txt" },
      scriptResult: {
        complete: true,
        matches: {
          length: 150,
          149: { path: "list.txt", line: 150, text: "row 150", lineText: "row 150" },
        },
      },
    },
    { tool: "replace", args: { path: /^RESULT#[a-f\d-]{36}$/u }, reuse: reuse(0) },
  ],
  {
    modes: ["codemode"],
    files: { "list.txt": `${rows.join("\n")}\n` },
    expected: { "list.txt": `${[...rows.slice(0, -1), "LAST"].join("\n")}\n` },
    answer: "150",
  },
);

const fileHookDenialReason = "Policy marker: KEEP_EXISTING\nPolicy marker: SIBLING_CHECK?!";
for (const mode of ["direct", "codemode"] as const) {
  const refusal: Pick<RouteStep, "error" | "contains" | "parentContains"> = {
    error: true,
    contains: fileHookDenialReason,
    ...(mode === "codemode" && { parentContains: fileHookDenialReason.split("\n") }),
  };
  add(
    `file-hook-denials-${mode}`,
    ["edit.write-hook-denial", "edit.directory-transfer-hook-denial"],
    `Attempt three independent changes: Write hook-locked-write.txt with "new\\n" (a real newline), Copy copy-tree to hook-locked-copy, and Move move-tree to hook-locked-move. Use whole-object paths without selectors. The fixture enables filesystem YOLO and installs a before-edit hook that refuses all three changes. ${mode === "codemode" ? "Run the tools inside Codemode and inspect the final script result for the refusals. A refused child resolves to null." : "Use the direct tools and inspect each tool receipt."} Leave every file unchanged. Identify each refused call and report the hook's two reason lines verbatim. The repeated reason can be quoted once.`,
    [
      { tool: "write", args: { path: "hook-locked-write.txt" }, ...refusal },
      { tool: "copy", args: { path: "copy-tree", target: "hook-locked-copy" }, ...refusal },
      { tool: "move", args: { path: "move-tree", target: "hook-locked-move" }, ...refusal },
    ],
    {
      modes: [mode],
      setup: "file-hook-denials",
      git: true,
      files: {
        "hook-locked-write.txt": "keep write\n",
        "copy-tree/nested/item.txt": "copy source\n",
        "hook-locked-copy/nested/item.txt": "keep copy target\n",
        "move-tree/nested/item.txt": "move source\n",
        "hook-locked-move/nested/item.txt": "keep move target\n",
        "hook-locked-move/extra.txt": "keep move-only entry\n",
        ".pi/pi-agent-ide/extensions.json": JSON.stringify({
          flags: { "pi-agent-ide-filesystem-yolo": true },
        }),
      },
      answer: fileHookDenialReason,
    },
  );
}
add(
  "binary-copy-move",
  ["edit.copy-binary", "edit.move-binary", "compose.binary-copy-refusal"],
  "Copy source.bin to copy.bin without decoding it. With direct calls, report the Copy receipt and Search the unchanged Copy result for BAD to observe that it has no text selection. In Codemode that Copy resolves to null because it selects no text; skip that Search. Move copy.bin over existing.bin. Keep source.bin unchanged and do not edit any other files.",
  [
    {
      tool: "copy",
      args: { path: "source.bin", target: "copy.bin" },
      contains: "No verified text selection",
    },
    {
      tool: "search",
      reuse: reuse(0),
      error: true,
      contains: "no reusable text selection",
      // A Codemode script gets null for this Copy, so only a direct route can search its result.
      modes: ["direct"],
    },
    { tool: "move", args: { path: "copy.bin", target: "existing.bin" } },
  ],
  {
    files: { "source.bin": "binary\u0000bytes\n", "existing.bin": "prior\u0000bytes\n" },
    expected: { "copy.bin": null, "existing.bin": "binary\u0000bytes\n" },
  },
);
add(
  "read-text",
  ["read.text", "read.directory", "read.raw", "read.paging"],
  'Use Read with path "." to list this directory. Read task.txt with offset 2 and limit 1. Read raw:task.txt with offset 0 and limit 4 to get its first four original bytes. Report the line-2 value.',
  [
    { tool: "read", args: { path: "." } },
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 }, contains: "OLD" },
    { tool: "read", args: { path: "raw:task.txt", offset: 0, limit: 4 }, contains: "keep" },
  ],
  { answer: "OLD" },
);

for (const mode of both)
  add(
    `read-error-${mode}`,
    mode === "codemode"
      ? [
          "read.failure",
          "read.provider-failure-ownership",
          "codemode.failed-call-null",
          "codemode.failed-call-summary",
          "codemode.provider-failure-context",
        ]
      : ["read.failure", "read.provider-failure-ownership"],
    "Read absent.txt once, then fixture:read-provider#metadata once, then read task.txt. The synthetic provider declares the fragmented resource unavailable; do not retry its bare source or interpret metadata as text. Keep existing files unchanged and report the first line of task.txt. In Codemode, run the three Reads in one script: a failed Read resolves to null, so check each value for null and continue with the independent task.txt read. Do not catch errors or parse readable error text; the Codemode result lists the failed Reads.",
    [
      {
        tool: "read",
        args: { path: "absent.txt" },
        error: true,
        contains: "absent.txt",
        ...(mode === "codemode" ? { parentContains: "- read absent.txt" } : {}),
      },
      {
        tool: "read",
        args: { path: "fixture:read-provider#metadata" },
        error: true,
        contains: "fixture:read-provider#metadata",
        ...(mode === "codemode"
          ? {
              parentContains: ["- read fixture:read-provider#metadata", "fixture-recovery-context"],
            }
          : {}),
      },
      { tool: "read", args: { path: "task.txt" }, contains: "keep" },
    ],
    {
      modes: [mode],
      setup: "semantic-write",
      expected: {
        ...textFile,
        "provider-reads.jsonl": '"fixture:read-provider#metadata"\n',
      },
      answer: "keep",
    },
  );
add(
  "read-jq",
  ["read.jq", "read.jq-paging"],
  "Use read with a jq view to select .status from config.json. Then read with jq:.status, .untouched, offset=2 and limit=1 to select the second transformed value. Report that number in plain digits. Do not edit anything.",
  [
    { tool: "read", args: { path: "config.json", views: ["jq:.status"] }, contains: "ready" },
    {
      tool: "read",
      args: { views: ["jq:.status, .untouched"], offset: 2, limit: 1 },
      // The first whole-file Read result names the same complete JSON source.
      reuse: { ...reuse(0), explicit: "config.json" },
      contains: "7",
    },
  ],
  {
    files: { "config.json": '{"status":"ready","untouched":7}\n' },
    expected: { "config.json": '{"status":"ready","untouched":7}\n' },
    answer: "7",
    prerequisite: "jq",
  },
);

add(
  "read-jq-bounded-input",
  ["read.jq-bounded-input"],
  "Read the first line of config.json. Pass that unchanged Read result or its UUID to Read with views jq:.status; the bounded-input query must be refused. Then query jq:.status using the explicit config.json path and report its value. Do not edit or widen the issued selection.",
  [
    {
      tool: "read",
      args: { path: "config.json", offset: 1, limit: 1 },
    },
    { tool: "read", args: { views: ["jq:.status"] }, reuse: reuse(0), error: true },
    { tool: "read", args: { path: "config.json", views: ["jq:.status"] }, contains: "ready" },
  ],
  {
    files: { "config.json": '{\n  "status": "ready"\n}\n' },
    expected: { "config.json": '{\n  "status": "ready"\n}\n' },
    answer: "ready",
    prerequisite: "jq",
  },
);
add(
  "read-search-replace",
  ["compose.read-search", "compose.search-replace", "compose.provider-reference-roundtrip"],
  "Read task.txt. Pass the unchanged Read result or its UUID into search for OLD, then pass the Search result into replace to change just OLD to NEW. Do not retype a file path for the dependent calls. In Codemode, when the runtime offers local MCP forwarding aliases for Search or Replace, use those aliases rather than their flat source names; still pass the actual returned references.",
  [
    { tool: "read", args: { path: "task.txt" } },
    { tool: "search", reuse: reuse(0) },
    { tool: "replace", reuse: reuse(1) },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

add(
  "rust-style-preservation",
  ["edit.rust-style-preservation"],
  'Use Replace with these exact inputs: {"path":"unformatted.rs","at":"value=1","text":"value=2"} and {"path":"formatted.rs","at":"let value = 1;","text":"let value=2;"}. The second replacement payload deliberately has no spaces around =. Submit that payload unchanged so the formatter exercises preservation of the existing formatted style and produces let value = 2;. Keep every other byte, including child.rs, unchanged.',
  [
    { tool: "replace", args: { path: "unformatted.rs", at: "value=1", text: "value=2" } },
    {
      tool: "replace",
      args: { path: "formatted.rs", at: "let value = 1;", text: "let value=2;" },
    },
  ],
  {
    files: {
      "Cargo.toml":
        '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "formatted.rs"\n',
      "Cargo.lock":
        '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "fixture"\nversion = "0.1.0"\n',
      "unformatted.rs": 'fn main(){let value=1;println!("{}",value);}\n',
      "formatted.rs": "mod child;\n\nfn main() {\n    let value = 1;\n}\n",
      "child.rs": 'pub fn child(){println!("untouched");}\n',
    },
    expected: {
      "unformatted.rs": 'fn main(){let value=2;println!("{}",value);}\n',
      "formatted.rs": "mod child;\n\nfn main() {\n    let value = 2;\n}\n",
      "child.rs": 'pub fn child(){println!("untouched");}\n',
    },
    prerequisite: "command -v cargo && command -v rustfmt",
    postProcessing: true,
  },
);

add(
  "codemode-child-presentation",
  ["compose.codemode-child-result"],
  "In one native Codemode call, read task.txt and pass the unchanged Read result to text(). Keep the file unchanged. After the call, answer only CODEMODE-CHILD-MARKER. Do not use shell commands or substitute a standalone Read.",
  [
    {
      tool: "read",
      args: { path: "task.txt" },
      contains: "CODEMODE-CHILD-MARKER",
      parentContains: "CODEMODE-CHILD-MARKER",
    },
  ],
  {
    modes: ["codemode"],
    files: { "task.txt": "CODEMODE-CHILD-MARKER\n" },
    expected: { "task.txt": "CODEMODE-CHILD-MARKER\n" },
    answer: "CODEMODE-CHILD-MARKER",
  },
);
const streamedReplacement = Array.from(
  { length: 96 },
  (_, index) => `STREAM-PAYLOAD-${String(index + 1).padStart(4, "0")}`,
).join("\n");
add(
  "streamed-replace",
  ["edit.large-replace-payload"],
  `Use direct replace on task.txt with at OLD and text equal to this complete JSON string: ${JSON.stringify(streamedReplacement)}. Supply the literal text in the tool arguments, not a script, reference, abbreviation or repetition expression. Wait for the Replace result before reading the first two lines of the saved file and reporting STREAM-PAYLOAD-0001. Keep the surrounding keep and last lines unchanged.`,
  [
    { tool: "replace", args: { path: "task.txt", at: "OLD", text: streamedReplacement } },
    {
      tool: "read",
      args: { path: "task.txt", offset: 1, limit: 2 },
      after: [0],
      contains: "STREAM-PAYLOAD-0001",
    },
  ],
  {
    modes: ["direct"],
    expected: { "task.txt": `keep\n${streamedReplacement}\nlast\n` },
    answer: "STREAM-PAYLOAD-0001",
  },
);

add(
  "issued-result-edit",
  [
    "edit.issued-result-streaming",
    "edit.result-anchor-combination",
    "compose.native-provider-auth",
  ],
  "Search task.txt for OLD. Replace the selected OLD with NEW by passing the unchanged Search result or its outer UUID as path, with text NEW and no selectors. Wait for the first Replace result before searching the file again for NEW. Replace with that fresh Search result or UUID as path, at NEW, and text FINAL. This selector must resolve inside the issued selection, not treat its UUID as a filename. Wait for the second Replace result before reading the current file and reporting FINAL. Keep every other byte unchanged.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    {
      tool: "replace",
      args: {
        at: undefined,
        from: undefined,
        after: undefined,
        through: undefined,
        before: undefined,
      },
      reuse: reuse(0),
    },
    { tool: "search", args: { path: "task.txt", query: "NEW" }, after: [1] },
    {
      tool: "replace",
      args: { at: "NEW" },
      reuse: reuse(2),
    },
    { tool: "read", args: { path: "task.txt" }, contains: "FINAL", after: [3] },
  ],
  { modes: ["direct"], expected: { "task.txt": "keep\nFINAL\nlast\n" }, answer: "FINAL" },
);

add(
  "read-scoped-boolean",
  ["compose.scoped-boolean"],
  'Read only line 2 of task.txt. Forward that result or its UUID to Search twice, using the exact queries `feature: "legacy​Checkout"` and `feature: AND outside`. Report both search results. Do not search the file path or change bytes.',
  [
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } },
    {
      tool: "search",
      args: { query: 'feature: "legacy​Checkout"' },
      reuse: reuse(0),
      contains: "1 match in 1 file",
    },
    {
      tool: "search",
      args: { query: "feature: AND outside" },
      reuse: reuse(0),
      contains: "No matches found",
    },
  ],
  {
    files: {
      "task.txt":
        'outside feature: "legacy​Checkout"\nfeature: "legacy​Checkout"\noutside feature: "legacy​Checkout"\n',
    },
  },
);
add(
  "search-issued-scope",
  ["compose.search-issued-scope", "compose.search-object-scope"],
  'Search task.txt for title. Pass the title Search\'s issued SEARCH :all:line selector as an object {"id":"SEARCH#…:all:line"} in Search path for legacyCheckout: there must be zero matches, because all feature lines are gaps. Use the same object form for the title Search\'s first :line when searching for first (one match), then the title Search\'s first :match for first (zero). Keep the bytes unchanged and use the exact issued selectors, not a file path or UUID.',
  [
    { tool: "search", args: { path: "task.txt", query: "title" } },
    {
      tool: "search",
      args: { path: { id: /^SEARCH#[A-F0-9]+:all:line$/ }, query: "legacyCheckout" },
      reuse: reuse(0),
      contains: "No matches found",
    },
    {
      tool: "search",
      args: { path: { id: /^SEARCH#[A-F0-9]+:1:line$/ }, query: "first" },
      reuse: reuse(0),
      contains: "1 match in 1 file",
    },
    {
      tool: "search",
      args: { path: { id: /^SEARCH#[A-F0-9]+:1:match$/ }, query: "first" },
      reuse: reuse(0),
      contains: "No matches found",
    },
  ],
  {
    // Numbered and :all selectors exist only in readable results; Codemode values carry ids.
    modes: ["direct"],
    files: {
      "task.txt":
        "title first\nfeature legacyCheckout\ntitle middle\nfeature legacyCheckout\ntitle final\n",
    },
  },
);
{
  const slots = ["apple", "banana", "cherry", "date", "elderberry", "fig"];
  add(
    "parallel-same-file-replace",
    ["edit.parallel-same-file-replace"],
    (api) =>
      `Read parallel.txt. Then send six Replace calls on parallel.txt: for each of ${slots.join(", ")}, use literal at "old <name>" and text "new <name>", substituting the corresponding name. ${parallelCalls(api, slots.length)} Do not retry or send the edits one at a time. Preserve the brackets, CRLF separators and absence of a final newline.`,
    [
      { tool: "read", args: { path: "parallel.txt" } },
      ...slots.map((slot, index): RouteStep => ({
        tool: "replace",
        args: { path: "parallel.txt", at: `old ${slot}` },
        exactText: ["at"],
        after: [0],
        ...(index > 0 && { sameAssistantWith: 1 }),
      })),
    ],
    {
      modes: ["direct"],
      files: { "parallel.txt": slots.map((slot) => `[old ${slot}]`).join("\r\n") },
      expected: { "parallel.txt": slots.map((slot) => `[new ${slot}]`).join("\r\n") },
    },
  );
}
for (const operation of ["delete", "insert"] as const) {
  add(
    `search-line-batch-${operation}`,
    [
      `edit.search-line-batch-${operation}`,
      ...(operation === "insert" ? ["compose.batch-insert-search"] : []),
    ],
    (api) =>
      `Search task.txt for OLD. Use the three issued numbered SEARCH :line references as path for the three ${operation} calls. ${operation === "delete" ? "Remove only those selected lines and keep the file." : "Insert ADDED followed by a newline after each selected line."} ${parallelCalls(api, 3)} Do not use Codemode, sequential retries or rereads; keep all other bytes.${operation === "insert" ? " After the batch completes, Search each Insert result or UUID for ADDED (one match) and OLD OR keep (zero matches). Use the exact unquoted Boolean query OLD OR keep; do not quote it as one literal or translate it to regex. Keep those scopes separate." : ""}`,
    [
      { tool: "search", args: { path: "task.txt", query: "OLD" } },
      ...[1, 2, 3].map((index): RouteStep => ({
        tool: operation,
        args: {
          path: new RegExp(`^SEARCH#[A-F0-9]+:${index}:line$`, "u"),
          ...(operation === "insert" && { text: "ADDED\n" }),
        },
        reuse: reuse(0),
        ...(index > 1 && { sameAssistantWith: 1 }),
      })),
      ...(operation === "insert"
        ? [1, 2, 3].flatMap((index): RouteStep[] => [
            {
              tool: "search",
              args: { query: "ADDED" },
              reuse: reuse(index),
              contains: "1 match in 1 file",
            },
            {
              tool: "search",
              args: { query: "OLD OR keep" },
              reuse: reuse(index),
              contains: "No matches found",
            },
          ])
        : []),
    ],
    {
      modes: ["direct"],
      files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\nOLD\n" },
      expected: {
        "task.txt":
          operation === "delete"
            ? "keep1\nkeep2\nkeep3\n"
            : "keep1\nOLD\nADDED\nkeep2\nOLD\nADDED\nkeep3\nOLD\nADDED\n",
      },
    },
  );
}
for (const operation of ["replace", "delete", "insert"] as const) {
  add(
    `selection-batch-${operation}`,
    [
      `edit.selection-batch-${operation}`,
      ...(operation === "replace" ? ["compose.batch-replace-search"] : []),
    ],
    (api) =>
      `Read complete lines 2, 4 and 6 of task.txt as three separate one-line windows (offset 2, 4 and 6 respectively, each with limit 1) before editing. Forward each corresponding Read result or UUID to its ${operation} call without another anchor. ${operation === "replace" ? "Replace each selected line with NEW followed by a newline." : operation === "delete" ? "Delete only these lines, keeping the file." : "Insert ADDED followed by a newline after each selected line."} ${parallelCalls(api, 3)} Do not use Codemode, sequential messages, rereads or retries. Keep every other byte.${operation === "replace" ? " After the batch completes, Search each Replace result or UUID for NEW (one match) and OLD OR keep (zero matches). Use the exact unquoted Boolean query OLD OR keep; do not quote it as one literal or translate it to regex. Keep those scopes separate." : ""}`,
    [
      ...[2, 4, 6].map((line): RouteStep => ({
        tool: "read",
        args: { path: "task.txt", offset: line, limit: 1 },
      })),
      ...[0, 1, 2].map((index): RouteStep => ({
        tool: operation,
        reuse: reuse(index),
        ...(index > 0 && { sameAssistantWith: 3 }),
      })),
      ...(operation === "replace"
        ? [3, 4, 5].flatMap((index): RouteStep[] => [
            {
              tool: "search",
              args: { query: "NEW" },
              reuse: reuse(index),
              contains: "1 match in 1 file",
            },
            {
              tool: "search",
              args: { query: "OLD OR keep" },
              reuse: reuse(index),
              contains: "No matches found",
            },
          ])
        : []),
    ],
    {
      modes: ["direct"],
      files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\nOLD\n" },
      expected: {
        "task.txt":
          operation === "replace"
            ? "keep1\nNEW\nkeep2\nNEW\nkeep3\nNEW\n"
            : operation === "delete"
              ? "keep1\nkeep2\nkeep3\n"
              : "keep1\nOLD\nADDED\nkeep2\nOLD\nADDED\nkeep3\nOLD\nADDED\n",
      },
    },
  );
}
add(
  "insert-search-anchor-list",
  ["edit.insert-search-anchor-list"],
  "Search task.txt for OLD, then separately search task.txt for TAIL. Make ONE Insert call whose path is an array of two actual issued references: the first :line reference of the OLD search and the first :line reference of the TAIL search. Insert ADDED followed by a newline after each selected line without a selector. Do not retype the file path and do not retry. Keep every other byte.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    { tool: "search", args: { path: "task.txt", query: "TAIL" } },
    {
      tool: "insert",
      args: {
        path: [/^SEARCH#[A-F0-9]+:1:line$/u, /^SEARCH#[A-F0-9]+:1:line$/u],
        text: "ADDED\n",
      },
      reuse: [reuse(0), reuse(1)],
    },
  ],
  {
    // Line references exist only in readable results; a Codemode Search value has no line ids.
    modes: ["direct"],
    files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\nTAIL\n" },
    expected: { "task.txt": "keep1\nOLD\nADDED\nkeep2\nOLD\nkeep3\nTAIL\nADDED\n" },
  },
);
for (const operation of ["insert", "replace", "delete"] as const) {
  const selector = operation === "insert" ? "before" : "at";
  const lineReference = /^SEARCH#[A-F0-9]+:1:line$/u;
  add(
    `${operation}-list-selectors-refused`,
    [`edit.${operation}-list-selectors-refused`],
    `Search task.txt for OLD, then separately search task.txt for TAIL. Call ${operation} with path as an array of the first issued :line reference from each search, AND ${selector} as the first search's same :line reference.${operation === "delete" ? "" : " Use text NEW."} This ambiguous combination must fail without changing either target. After that failure, retry once with the same path array but omit ${selector}; ${operation === "insert" ? "insert NEW after both selected lines with text NEW followed by a newline" : operation === "replace" ? "replace each of both selected lines with NEW followed by a newline" : "delete both selected lines, keeping the file"}. Do not retype the file path, reread or search again. Keep every other byte.`,
    [
      { tool: "search", args: { path: "task.txt", query: "OLD" } },
      { tool: "search", args: { path: "task.txt", query: "TAIL" } },
      {
        tool: operation,
        args: {
          path: [lineReference, lineReference],
          [selector]: lineReference,
        },
        error: true,
        reuse: [reuse(0), reuse(1), reuse(0, selector)],
      },
      {
        tool: operation,
        args: {
          path: [lineReference, lineReference],
          ...(operation === "insert" ? { text: "NEW\n" } : {}),
        },
        after: [2],
        reuse: [reuse(0), reuse(1)],
      },
    ],
    {
      // Readable Search line references are not part of the Codemode Search value.
      modes: ["direct"],
      files: { "task.txt": "keep1\nOLD\nkeep2\nTAIL\nkeep3\n" },
      expected: {
        "task.txt":
          operation === "insert"
            ? "keep1\nOLD\nNEW\nkeep2\nTAIL\nNEW\nkeep3\n"
            : operation === "replace"
              ? "keep1\nNEW\nkeep2\nNEW\nkeep3\n"
              : "keep1\nkeep2\nkeep3\n",
      },
    },
  );
}
const scalarCalls = "Vec scalar: OLD(x, b), OLD(y, b)";
const vectorCalls = "Vec vector: OLD(x, b.x), OLD(y, b.y)";
const declarations = "Vec<OLD> first(Vec);\nVec<OLD> second(Vec);";
const callLines = `${scalarCalls}\n${vectorCalls}\n${declarations}`;
const renamedScalarCalls = scalarCalls.replace("Vec ", "Vector ");
const renamedVectorCalls = vectorCalls.replace("Vec ", "Vector ");
const renamedDeclarations = declarations.replaceAll("Vec", "Vector");
const renamedCallLines = `${renamedScalarCalls}\n${renamedVectorCalls}\n${renamedDeclarations}`;
const movedReferenceBlock =
  [
    "BLOCK_START",
    "OLD",
    callLines,
    ...Array.from({ length: 800 }, (_, index) => `moved_${index}`),
    "BLOCK_END",
  ].join("\n") + "\n";
const crossedReferenceBlock =
  [
    "keep2",
    "OLD",
    ...Array.from({ length: 800 }, (_, index) => `crossed_${index}`),
    "TAIL",
    "DESTINATION",
  ].join("\n") + "\n";
add(
  "replace-search-anchor-list",
  ["edit.replace-search-anchor-list"],
  [
    "Search task.txt for OLD and separately for TAIL. Wait for both results.",
    'Move the block from the exact line "BLOCK_START\\n" through "BLOCK_END\\n" (inclusive) in task.txt to immediately after the exact line "DESTINATION\\n" in the same file. Pass path, from, through, target and targetAfter to Move.',
    `After Move, call Replace with path "task.txt", at set to the literal four-line string ${JSON.stringify(callLines)}, and text set to ${JSON.stringify(renamedCallLines)}.`,
    "After that edit, make one Replace call with text NEW and path set to an array of six references: OLD matches 1, 2, 3, 6 and 7, then TAIL match 1, from the original searches. Use their numbered :match references in direct calls and their match values or ids in Codemode. Do not search again, pass selectors to this final Replace, or change the other OLD matches.",
  ].join(" "),
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    { tool: "search", args: { path: "task.txt", query: "TAIL" } },
    {
      tool: "move",
      args: { path: "task.txt", target: "task.txt" },
      exactText: ["from", "through", "targetAfter"],
      after: [0, 1],
    },
    {
      tool: "replace",
      args: { path: "task.txt" },
      exactText: ["at"],
      after: [2],
    },
    {
      tool: "replace",
      args: { path: [1, 2, 3, 6, 7, 1].map(matchReference) },
      reuse: [reuse(0), reuse(0), reuse(0), reuse(0), reuse(0), reuse(1)],
      after: [3],
    },
  ],
  {
    files: { "task.txt": movedReferenceBlock + crossedReferenceBlock },
    expected: {
      "task.txt":
        crossedReferenceBlock.replace("TAIL", "NEW") +
        movedReferenceBlock
          .replace("OLD", "NEW")
          .replace(
            callLines,
            `${renamedScalarCalls.replaceAll("OLD", "NEW")}\n${renamedVectorCalls}\n${renamedDeclarations.replaceAll("OLD", "NEW")}`,
          ),
    },
  },
);
add(
  "replace-already-done-anchor-list",
  ["edit.already-done-targets"],
  "Search task.txt for regex:OLD|NEW. Make ONE Replace call whose path is an array of all four actual matches of that search (their :match references in direct calls, the matches themselves or their ids in Codemode), replacing each with NEW. Two selected matches already contain NEW: the call must succeed, change the other two and name the targets that already had NEW. Do not retype the file path and do not retry. Keep every other byte.",
  [
    { tool: "search", args: { path: "task.txt", query: "regex:OLD|NEW" } },
    {
      tool: "replace",
      args: {
        path: [1, 2, 3, 4].map(matchReference),
      },
      reuse: [reuse(0), reuse(0), reuse(0), reuse(0)],
      contains: "Already had this text, left as is: 2 targets",
    },
  ],
  {
    files: { "task.txt": "keep1\nOLD\nNEW\nkeep2\nNEW\nOLD\n" },
    expected: { "task.txt": "keep1\nNEW\nNEW\nkeep2\nNEW\nNEW\n" },
  },
);
add(
  "replace-surviving-scoped-match",
  ["edit.surviving-scoped-match"],
  "Search task.txt for OLD once and retain the whole returned result. Replace its first match with ONE, passing that whole Search result as path ({id: its returned UUID} in direct calls, the returned value in Codemode) and its first match as at (the issued :match reference in direct calls, the first match value in Codemode). Wait for the first Replace result so its match is stale before making one Replace call with path as an array of the first and second matches and text TWO; the stale first match must make it fail without writing. Wait for that refusal before replacing only the second match with TWO, using the SAME WHOLE Search result as path and its second match as at. Changing the second match before the refusal would invalidate that reference too. Do not pass the second match as path, retype the file path, search again or use other edits. Preserve every other byte.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    {
      tool: "replace",
      args: { at: matchReference(1), text: "ONE" },
      reuse: [reuse(0, "path", "whole-result"), reuse(0, "at")],
    },
    {
      tool: "replace",
      args: { path: [matchReference(1), matchReference(2)], text: "TWO" },
      error: true,
      after: [1],
      reuse: [reuse(0), reuse(0)],
    },
    {
      tool: "replace",
      args: { at: matchReference(2), text: "TWO" },
      after: [2],
      reuse: [reuse(0, "path", "whole-result"), reuse(0, "at")],
    },
  ],
  {
    files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\n" },
    expected: { "task.txt": "keep1\nONE\nkeep2\nTWO\nkeep3\n" },
  },
);
add(
  "replace-search-anchor-list-unusable",
  ["edit.search-anchor-list-unusable"],
  "Search task.txt for OLD. Replace its first match alone with ONE: use that Search result as path ({id: its returned UUID} in direct calls, the returned value in Codemode) and its first :match reference as at (the first match value in Codemode). Wait for this first Replace result so its match is stale before making ONE Replace call whose path is an array of the first and the second match of that same search, replacing both with TWO. The first match was just changed, so the call must fail, name that reference and change nothing. Wait for that refusal before calling Replace once with only the second match and TWO; changing it earlier would also invalidate the second reference in the refused call. Do not search again and do not retype the file path. Keep every other byte.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    {
      tool: "replace",
      args: { path: matchReference(1) },
      reuse: reuse(0),
    },
    {
      tool: "replace",
      args: {
        path: [matchReference(1), matchReference(2)],
      },
      error: true,
      after: [1],
      reuse: [reuse(0), reuse(0)],
    },
    {
      tool: "replace",
      args: { path: matchReference(2) },
      after: [2],
      reuse: reuse(0),
    },
  ],
  {
    files: { "task.txt": "keep1\nOLD\nkeep2\nOLD\nkeep3\n" },
    expected: { "task.txt": "keep1\nONE\nkeep2\nTWO\nkeep3\n" },
  },
);
for (const operation of ["delete", "insert"] as const) {
  add(
    `read-window-${operation}`,
    [
      ...(operation === "insert" ? ["edit.whole-line-spans"] : []),
      `compose.read-window-${operation}`,
    ],
    `Read only the second line of task.txt (offset 2, limit 1). Forward that Read result or its UUID to ${operation}. Do not add a separate anchor or retype the file path. ${operation === "delete" ? "Remove only that line; keep the file." : "Insert ADDED followed by a newline after the selected line. In inline.txt, also Read only its second line and use that result in a separate Insert call with text :SUFFIX and no newline. Keep every original byte."}`,
    [
      { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } },
      {
        tool: operation,
        ...(operation === "insert" && {
          args: { before: undefined },
        }),
        reuse: reuse(0),
      },
      ...(operation === "insert"
        ? ([
            { tool: "read", args: { path: "inline.txt", offset: 2, limit: 1 } },
            { tool: "insert", args: { text: ":SUFFIX" }, reuse: reuse(2) },
          ] satisfies RouteStep[])
        : []),
    ],
    {
      files: operation === "insert" ? { ...textFile, "inline.txt": "keep\nOLD\nlast\n" } : textFile,
      expected: {
        "task.txt": operation === "delete" ? "keep\nlast\n" : "keep\nOLD\nADDED\nlast\n",
        ...(operation === "insert" ? { "inline.txt": "keep\nOLD:SUFFIX\nlast\n" } : {}),
      },
    },
  );
}
add(
  "grouped-replace-file-count",
  ["edit.grouped-file-count"],
  "In one native Codemode script, sequentially read lines 1, 2, then 3 of task.txt as one-line windows (offset equal to that line number, each with limit 1) and replace each issued Read result with NEW followed by a newline. Await each replacement before reading the next line so each gets a fresh snapshot. Inspect the final editor summary: it must report three replacements in one file, not three files.",
  [1, 2, 3].flatMap((line, index): RouteStep[] => [
    {
      tool: "read",
      args: { path: "task.txt", offset: line, limit: 1 },
      ...(index > 0 && { after: [index * 2 - 1] }),
    },
    {
      tool: "replace",
      reuse: reuse(index * 2),
      ...(line === 3 && { parentContains: "Applied 3 replacements in 1 file." }),
    },
  ]),
  {
    modes: ["codemode"],
    files: { "task.txt": "OLD\nOLD\nOLD\n" },
    expected: { "task.txt": "NEW\nNEW\nNEW\n" },
  },
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
    `Read all of large.ts so it returns a compact overview. Search for NEEDLE by passing that unchanged Read result or its UUID, not the file path. Then read large.ts with offset=2 and limit=${rows + 3}, and make two separate Search calls, each with that new overview unchanged as path: one with the exact query NEEDLE, the other with the exact query outsideBefore. These two Searches are independent. Report the source line of the body match and whether outsideBefore was found in the window. Do not edit anything.`,
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
    // The overview is model-facing only: a Codemode script reads the exact text.
    { modes: ["direct"], files, expected: files },
  );
}
const storedOverview = overviewFixtures[0];
if (storedOverview === undefined) throw new Error("Missing overview fixture");
add(
  "read-large-store",
  ["compose.large-read-store-load"],
  "In one Codemode call, read large.ts with offset=2 and limit=2103, and store the unchanged Read result. In a second successful Codemode call, load that result and search it for NEEDLE, then pass the Search result to replace NEEDLE with FOUND. Do not reread the file or retype its path for the dependent calls. After the Replace result returns, load and search the original saved Read result for NEEDLE again and report whether the edited region still contains it.",
  [
    {
      tool: "read",
      args: { path: "large.ts", offset: 2, limit: 2103 },
      contains: 'consume("NEEDLE")',
    },
    {
      tool: "search",

      reuse: { ...reuse(0), newParent: true },
      contains: "large.ts:103:12-18",
    },
    { tool: "replace", reuse: reuse(1) },
    {
      tool: "search",

      reuse: reuse(0),
      contains: "No matches found",
      after: [2],
    },
  ],
  {
    modes: ["codemode"],
    files: storedOverview.files,
    expected: {
      "large.ts": storedOverview.files["large.ts"].replace('consume("NEEDLE")', 'consume("FOUND")'),
    },
  },
);

const largeJsonRows = Array.from({ length: 2500 }, (_, id) => ({
  id,
  name: `row ${id}`,
  status: "open",
}));
add(
  "read-large-json-script",
  ["codemode.read-exact-text"],
  "In one Codemode script, read data.json, a file larger than the model output limit, and parse its text with JSON.parse. Set status to done for the record with id 2499, then write the whole file back with JSON.stringify(rows, null, 2). Do not use Bash or the raw: prefix.",
  [
    { tool: "read", args: { path: "data.json" }, contains: '"name": "row 1250"' },
    { tool: "write", args: { path: "data.json" }, after: [0] },
  ],
  {
    modes: ["codemode"],
    files: { "data.json": JSON.stringify(largeJsonRows, null, 2) },
    expected: {
      "data.json": JSON.stringify(
        largeJsonRows.map((row) => (row.id === 2499 ? { ...row, status: "done" } : row)),
        null,
        2,
      ),
    },
  },
);

add(
  "read-script-values",
  ["codemode.read-bytes", "codemode.read-entries", "codemode.read-path-list"],
  'In one Codemode script, read raw:data.bin and take its base64 bytes, read the directory at path "folder" and take its entries sorted, and read a.txt, missing.txt and c.txt in one Read call with an array path; a path that fails becomes null. Write summary.txt with three lines and a final newline: the base64 bytes, the entries joined by commas, and the array items\' texts without their trailing newline joined by |, with missing for a null item. Do not use Bash.',
  [
    { tool: "read", args: { path: "raw:data.bin" } },
    { tool: "read", args: { path: "folder" } },
    { tool: "read", args: { path: ["a.txt", "missing.txt", "c.txt"] }, error: true },
    { tool: "write", args: { path: "summary.txt" }, after: [0, 1, 2] },
  ],
  {
    modes: ["codemode"],
    files: {
      "data.bin": "hi\n",
      "folder/b.txt": "beta\n",
      "folder/sub/x.txt": "x\n",
      "a.txt": "alpha\n",
      "c.txt": "gamma\n",
    },
    expected: { "summary.txt": "aGkK\nb.txt,sub/\nalpha|missing|gamma\n" },
  },
);

add(
  "search-anchor-insert",
  ["edit.whole-line-spans", "search.text", "compose.search-insert", "edit.insert"],
  "Search for OLD using task.txt as path. Insert NEW on the following line. In direct mode use the issued :line anchor as insert.path, or use task.txt as path plus that anchor as after. In Codemode pass the first Search match value unchanged, or its id, as insert.path. Use text NEW with one leading and one trailing newline in both modes. Do not combine a result input with an anchor argument. Do not supply an extra blank line.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    {
      tool: "insert",
      modes: ["direct"],
      reuse: reuse(0, ["after", "path"], "anchor"),
    },
    { tool: "insert", modes: ["codemode"], reuse: reuse(0) },
  ],
  { expected: { "task.txt": "keep\nOLD\nNEW\nlast\n" } },
);

add(
  "search-multiline-between",
  ["search.multiline", "compose.search-multiline-replace", "compose.search-retained-result"],
  "Search task.txt with query regex:old one\\nold two\\n(?=END) and multiline true; pass backslash-n escapes in the regex. This selects both old lines and their following line breaks, not the marker lines. In Codemode confirm its only match has text old one followed by a newline, old two and a final newline. Retain this result. Run Bash with command \"printf '%s\\n' 'peer note' >> task.txt\" to append one line. Then Search task.txt with query keep. Replace the FIRST Search selection with text NEW and no newline, reusing its original reference or value, not the later Search. Keep the marker lines, the appended line and all other bytes.",
  [
    {
      tool: "search",
      args: { path: "task.txt", query: /^regex:/, multiline: true },
      modes: ["direct"],
    },
    {
      tool: "search",
      args: { path: "task.txt", query: /^regex:/, multiline: true },
      modes: ["codemode"],
      scriptResult: {
        complete: true,
        matches: { length: 1, 0: { text: "old one\nold two\n" } },
      },
    },
    { tool: "bash", modes: ["direct"], after: [0] },
    { tool: "bash", modes: ["codemode"], after: [1] },
    { tool: "search", args: { path: "task.txt", query: "keep" }, modes: ["direct"], after: [2] },
    { tool: "search", args: { path: "task.txt", query: "keep" }, modes: ["codemode"], after: [3] },
    {
      tool: "replace",
      args: { text: "NEW" },
      modes: ["direct"],
      reuse: reuse(0, ["path", "at"]),
      after: [4],
    },
    {
      tool: "replace",
      args: { text: "NEW" },
      modes: ["codemode"],
      reuse: reuse(1, ["path", "at"]),
      after: [5],
    },
  ],
  {
    files: { "task.txt": "keep\nBEGIN\nold one\nold two\nEND\nkeep\n" },
    expected: { "task.txt": "keep\nBEGIN\nNEW\nEND\nkeep\npeer note\n" },
  },
);

add(
  "search-query",
  ["search.text", "search.boolean", "search.regex", "file_search.glob", "search.flags"],
  "Use file_search with path . and pattern task*.txt. Search task.txt with the exact unquoted Boolean query alpha AND beta AND NOT skip. Search task.txt again with query regex:beta, wholeWord true, caseSensitive true and limit 1. Also Search task.txt for the plain text docs:debugger and then status:, passing each query unchanged. Report the Boolean matching line.",
  [
    { tool: "file_search", args: { pattern: /task\*?\.txt|task\*/ } },
    {
      tool: "search",
      args: {
        path: "task.txt",
        // Search reads a NOT factor anywhere in the conjunction alike.
        query:
          /^(?:(?:"alpha"|alpha) AND (?:"beta"|beta) (?:AND )?NOT (?:"skip"|skip)|NOT (?:"skip"|skip) AND (?:"alpha"|alpha) AND (?:"beta"|beta))$/,
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
    {
      tool: "search",
      args: { path: "task.txt", query: "docs:debugger" },
      contains: "DOCS-MARKER",
    },
    {
      tool: "search",
      args: { path: "task.txt", query: "status:" },
      contains: "STATUS-MARKER",
    },
  ],
  {
    files: {
      "task.txt":
        "alpha beta PASS-MARKER\nalpha beta skip\nAlpha BETAMAX\ndocs:debugger DOCS-MARKER\nstatus: STATUS-MARKER\n",
    },
    answer: "alpha beta PASS-MARKER",
  },
);

const listedDirectories = ["src/code-view", "src/api"];
const pathListFiles = {
  "src/code-view/format.ts":
    "export function formatSymbolSelector(name: string): string {\n  return name;\n}\n",
  "src/api/use.ts":
    'import { formatSymbolSelector } from "#format";\n\nexport const used = formatSymbolSelector("api"); // PASS-MARKER\n',
  "src/other/skip.ts":
    'import { formatSymbolSelector } from "#format";\n\nexport const skipped = formatSymbolSelector("other"); // OTHER-MARKER\n',
  "tsconfig.json":
    '{"compilerOptions":{"strict":true,"noEmit":true,"paths":{"#format":["./src/code-view/format.ts"]}},"include":["src"]}\n',
};
add(
  "search-path-list",
  ["search.path-list", "file_search.path-list", "ast_search.path-list"],
  "Look only in the directories src/code-view and src/api, never in src/other. Pass both directories together as one path list in each call: search for formatSymbolSelector, file_search for *.ts files, and ast_search for the calls formatSymbolSelector($$$ARGS). Report the file that calls formatSymbolSelector. Do not change files.",
  [
    {
      tool: "search",
      args: { path: listedDirectories },
      contains: "src/api/use.ts",
      excludes: "src/other",
    },
    {
      tool: "file_search",
      args: { path: listedDirectories },
      contains: "src/code-view/format.ts",
      excludes: "src/other",
    },
    {
      tool: "ast_search",
      args: { path: listedDirectories },
      contains: "PASS-MARKER",
      excludes: "OTHER-MARKER",
    },
  ],
  { files: pathListFiles, answer: "src/api/use.ts" },
);

add(
  "file-search-script-paths",
  [
    "file_search.script-paths",
    "file_search.script-limit",
    "file_search.sorted-limit",
    "compose.file-search-paths-read",
  ],
  "Use native Codemode. The logs directory holds 150 .log files. Call file_search for *.log in logs without a limit and check that its value lists all 150 paths. Call it again with limit 2 and verify the two paths are logs/entry-000.log and logs/entry-001.log in that order. Then read the path that ends with entry-137.log from the initial unlimited file_search result and report its content. Do not parse display text.",
  [
    {
      tool: "file_search",
      args: { pattern: /\*\.log|\.log/, path: "logs" },
      // A script's file_search has no default cap of 100 paths.
      scriptResult: { length: 150 },
    },
    {
      tool: "file_search",
      args: { pattern: /\*\.log|\.log/, path: "logs", limit: 2 },
      scriptResult: { length: 2, 0: "logs/entry-000.log", 1: "logs/entry-001.log" },
    },
    { tool: "read", args: { path: "logs/entry-137.log" }, contains: "PASS-137" },
  ],
  {
    modes: ["codemode"],
    files: Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [
        `logs/entry-${String(index).padStart(3, "0")}.log`,
        `PASS-${String(index)}\n`,
      ]),
    ),
    answer: "PASS-137",
  },
);

add(
  "lsp-path-list",
  ["lsp_search.path-list"],
  "Use lsp_search with query formatSymbolSelector once, passing the directories src/code-view and src/api together as one path list. Never search src/other. Report the files in which it finds formatSymbolSelector. Do not change files.",
  [
    {
      tool: "lsp_search",
      args: { path: listedDirectories, query: "formatSymbolSelector" },
      contains: "src/api/use.ts",
      excludes: "src/other",
    },
  ],
  {
    files: pathListFiles,
    answer: "src/api/use.ts",
    prerequisite: "command -v typescript-language-server",
  },
);

const workspaceApp = "frontend/src/App.ts";
const workspaceDeclaration = "frontend/src/composables/useRoleLabel.ts";
const workspaceUnopened = "frontend/src/composables/useTheme.ts";
add(
  "lsp-typescript-projects",
  ["lsp.typescript-workspace-projects"],
  "Use lsp_search with path frontend/src and query initTheme. Also use lsp_search with the same path and query useRoleLabel. Use the directory as the scope in both calls, without reference navigation. Report where initTheme and useRoleLabel are declared. Do not change files.",
  [
    {
      tool: "lsp_search",
      args: { path: "frontend/src", query: "initTheme" },
      issuedMatches: [{ path: workspaceUnopened, text: "initTheme", role: "definition" }],
    },
    {
      tool: "lsp_search",
      args: { path: "frontend/src", query: "useRoleLabel" },
      issuedMatches: [
        { path: workspaceDeclaration, text: "useRoleLabel", role: "definition" },
        { path: workspaceApp, text: "useRoleLabel", role: "reference" },
        { path: workspaceApp, text: "useRoleLabel", role: "reference" },
      ],
    },
  ],
  {
    files: {
      "frontend/tsconfig.json":
        '{"files":[],"references":[{"path":"./tsconfig.node.json"},{"path":"./tsconfig.app.json"}]}\n',
      "frontend/tsconfig.node.json":
        '{"compilerOptions":{"composite":true},"files":["src/00-tooling.d.ts"]}\n',
      "frontend/tsconfig.app.json":
        '{"compilerOptions":{"composite":true,"paths":{"@/*":["./src/*"]}},"include":["src"],"exclude":["src/00-tooling.d.ts"]}\n',
      "frontend/src/00-tooling.d.ts": "export declare const toolingOnly: unique symbol;\n",
      [workspaceApp]:
        'import { useRoleLabel } from "@/composables/useRoleLabel";\nexport const role = useRoleLabel();\n',
      [workspaceDeclaration]: 'export function useRoleLabel() { return "admin"; }\n',
      [workspaceUnopened]: 'export function initTheme() { return "dark"; }\n',
    },
    answer: workspaceUnopened,
    prerequisite: "command -v typescript-language-server",
  },
);

add(
  "lsp-independent-projects",
  ["lsp.independent-projects"],
  "Use lsp_search with query FindInFirstModule, then again with query FindInSecondModule. Search from the repository root for both and do not use reference navigation. Report the file that declares each name. Do not change files.",
  [
    {
      tool: "lsp_search",
      args: { query: "FindInFirstModule" },
      issuedMatches: [
        { path: "a-module/target.go", text: "FindInFirstModule", role: "definition" },
      ],
    },
    {
      tool: "lsp_search",
      args: { query: "FindInSecondModule" },
      issuedMatches: [
        { path: "b-module/target.go", text: "FindInSecondModule", role: "definition" },
      ],
    },
  ],
  {
    files: {
      "a-module/go.mod": "module example.com/a\n\ngo 1.24\n",
      "a-module/00-seed.go": "package a\n\nfunc Seed() int { return 0 }\n",
      "a-module/target.go": "package a\n\nfunc FindInFirstModule() int { return 1 }\n",
      "b-module/go.mod": "module example.com/b\n\ngo 1.24\n",
      "b-module/00-seed.go": "package b\n\nfunc Seed() int { return 0 }\n",
      "b-module/target.go": "package b\n\nfunc FindInSecondModule() int { return 1 }\n",
    },
    answer: "b-module/target.go",
    prerequisite: "command -v gopls && command -v go",
  },
);

const cappedGoQuery = { query: "'Cap", path: "target.go", limit: 200 };
add(
  "lsp-workspace-candidate-limit",
  ["lsp.workspace-candidate-limit"],
  "Use lsp_search to search for 'Cap (including the leading apostrophe) with path target.go and limit 200. Report the server candidate limit and whether the scoped result is complete. Do not change files.",
  [
    {
      tool: "lsp_search",
      args: cappedGoQuery,
      modes: ["direct"],
      contains: "gopls",
      excludes: ":all:match",
    },
    {
      tool: "lsp_search",
      args: cappedGoQuery,
      modes: ["codemode"],
      scriptResult: {
        complete: false,
        candidateLimits: { length: 1, 0: { server: "gopls", limit: 100 } },
        matches: { length: 1, 0: { path: "target.go", text: "Cap" } },
      },
    },
  ],
  {
    files: {
      "go.mod": "module example.com/capped\n\ngo 1.24\n",
      "decoys.go":
        "package capped\n\nconst Cap = 1\n" +
        Array.from({ length: 110 }, (_, i) => `const Cap${i} = 1\n`).join(""),
      "target.go":
        "package capped\n\ntype Holder struct { LongDisplacedDeclarationInTargetCap int }\n\nvar _ = Cap\n",
    },
    answer: "100",
    prerequisite: "command -v gopls && command -v go",
  },
);

add(
  "search-literal-operators",
  ["search.literal-operators", "search.script-line-text"],
  'Search task.txt with query equal to "flags | MASK", including the two double-quote characters around the phrase, so the vertical bar is literal. Report the full text of the only matching line. In Codemode use the returned match lineText, not text. Do not use Read or another tool to retrieve the line. Do not change files.',
  [
    {
      tool: "search",
      args: { path: "task.txt", query: /^"flags \| MASK"$/ },
      modes: ["direct"],
      contains: "PASS-MARKER",
      excludes: "flags only",
    },
    {
      tool: "search",
      args: { path: "task.txt", query: /^"flags \| MASK"$/ },
      modes: ["codemode"],
      scriptResult: {
        complete: true,
        matches: {
          length: 1,
          0: { text: "flags | MASK", lineText: "int x = flags | MASK; // PASS-MARKER" },
        },
      },
    },
  ],
  {
    files: {
      "task.txt":
        "int x = flags | MASK; // PASS-MARKER\nint y = flags; // flags only\nint z = MASK;\n",
    },
    answer: "int x = flags | MASK; // PASS-MARKER",
    forbiddenTools: ["read"],
  },
);

add(
  "read-anchor-replace",
  ["read.anchors", "edit.replace-range"],
  "Read task.txt with anchors. Using both returned line anchors as from and through, replace the inclusive first two lines with one line READY followed by a newline. Use the file path or omit path for this anchored edit, not a result scope. Keep last unchanged.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    {
      tool: "replace",
      args: {
        from: /^[0-9A-HJKMNP-TV-Z]{7}$/u,
        through: /^[0-9A-HJKMNP-TV-Z]{7}$/u,
      },
      reuse: [reuse(0, "from", "anchor"), reuse(0, "through", "anchor")],
    },
  ],
  { expected: { "task.txt": "READY\nlast\n" } },
);

add(
  "exact-range-replace",
  ["edit.replace-exact-range", "edit.leading-newline-range"],
  'Use Replace with paired literal endpoints and these exact inputs: {"path":"sentence.txt","from":"START","through":"END","text":"NEW"} and {"path":"credit.txt","from":"\\n\\nBased on","through":"(credit).","text":""}. The first call removes both endpoint fragments along with the text between them; its final line must be left NEW right, with the earlier END line and both line breaks unchanged. In the second input, decode each \\n as one newline character. Remove only that suffix, retaining the entire preceding paragraph and its punctuation. Do not rewrite either whole file or use line anchors.',
  [
    {
      tool: "replace",
      args: { path: "sentence.txt" },
      exactText: ["from", "through"],
    },
    {
      tool: "replace",
      args: {
        path: "credit.txt",
        text: "",
      },
      exactText: ["from", "through"],
    },
  ],
  {
    files: {
      "sentence.txt": "END before\nleft START old words END right\n",
      "credit.txt": "## Leave alone\n\nKEEP THIS PARAGRAPH.\n\nBased on [source](credit).",
    },
    expected: {
      "sentence.txt": "END before\nleft NEW right\n",
      "credit.txt": "## Leave alone\n\nKEEP THIS PARAGRAPH.",
    },
  },
);

add(
  "lenient-edit-ranges",
  ["edit.single-from", "edit.overlapping-inclusive-range"],
  'Copy from copy-source.txt to copy-target.txt with from "OPEN END-" alone, targetFrom "SLOT old", and targetThrough "SLOT". Move from move-source.txt to move-target.txt with from "OPEN END-", through "END", and targetFrom "SLOT old" alone. Do not pass at or targetAt. Select only OPEN END- in each source and replace only SLOT old in each target. Leave the text around the selected spans untouched.',
  [
    {
      tool: "copy",
      args: {
        path: "copy-source.txt",
        target: "copy-target.txt",
        from: "OPEN END-",
        through: undefined,
        before: undefined,
        targetFrom: "SLOT old",
        targetThrough: "SLOT",
      },
    },
    {
      tool: "move",
      args: {
        path: "move-source.txt",
        target: "move-target.txt",
        from: "OPEN END-",
        through: "END",
        targetFrom: "SLOT old",
        targetThrough: undefined,
        targetBefore: undefined,
      },
    },
  ],
  {
    files: {
      "copy-source.txt": "END before\r\nleft OPEN END-more stays\r\n",
      "copy-target.txt": "SLOT before\nleft SLOT old stays\n",
      "move-source.txt": "END before\r\nleft OPEN END-more stays\r\n",
      "move-target.txt": "SLOT before\nleft SLOT old stays\n",
    },
    expected: {
      "copy-source.txt": "END before\r\nleft OPEN END-more stays\r\n",
      "copy-target.txt": "SLOT before\nleft OPEN END- stays\n",
      "move-source.txt": "END before\r\nleft more stays\r\n",
      "move-target.txt": "SLOT before\nleft OPEN END- stays\n",
    },
  },
);

add(
  "replace-exclusive-range",
  ["edit.replace-exclusive-range"],
  'Use Replace to change only the text between // BEGIN and the // END that follows it in task.txt: pass "// BEGIN" as after, "// END" as before, and "new" as text. Keep all markers and later content. In empty.txt use the same boundaries to insert two lines, one containing first and one containing second, between adjacent markers. In block.txt replace the opening marker and body but keep the closing marker: use from "// BEGIN", before "// END", and text "new". In inline.txt keep "left " and replace everything after it through the semicolon: pass after "left ", through ";", and text "new;".',
  [
    {
      tool: "replace",
      args: { path: "task.txt", after: "// BEGIN", before: "// END", text: "new" },
      exactText: ["after", "before"],
    },
    {
      tool: "replace",
      args: { path: "empty.txt", after: "// BEGIN", before: "// END", text: "first\nsecond" },
      exactText: ["after", "before"],
    },
    {
      tool: "replace",
      args: { path: "block.txt", from: "// BEGIN", before: "// END", text: "new" },
      exactText: ["from", "before"],
    },
    {
      tool: "replace",
      args: { path: "inline.txt", after: "left ", through: ";", text: "new;" },
      exactText: ["after", "through"],
    },
  ],
  {
    files: {
      "task.txt": "// END\n// BEGIN\nold\n\n// END\nkeep\n",
      "empty.txt": "// BEGIN\r\n// END",
      "block.txt": "// BEGIN\nold\n// END\nkeep\n",
      "inline.txt": "left old; right\n",
    },
    expected: {
      "task.txt": "// END\n// BEGIN\nnew\n// END\nkeep\n",
      "empty.txt": "// BEGIN\r\nfirst\r\nsecond\r\n// END",
      "block.txt": "new\n// END\nkeep\n",
      "inline.txt": "left new; right\n",
    },
  },
);

add(
  "exact-range-delete",
  ["edit.delete-exact-range", "compose.search-range-endpoints"],
  "Search sentence.txt separately for DELETE_BEGIN and DELETE_END. Use the exact :match reference from each Search (in Codemode, the id of its match) as Delete from and through, respectively. Delete the inclusive span between those endpoints, retaining left, right, both surrounding spaces and the line ending. Do not use :line references, a whole-file deletion, or one combined Search result as the source.",
  [
    { tool: "search", args: { path: "sentence.txt", query: "DELETE_BEGIN" } },
    { tool: "search", args: { path: "sentence.txt", query: "DELETE_END" } },
    {
      tool: "delete",
      args: {
        path: "sentence.txt",
        from: matchReference(1),
        through: matchReference(1),
      },
      reuse: [reuse(0, "from", "anchor"), reuse(1, "through", "anchor")],
    },
  ],
  {
    files: { "sentence.txt": "left DELETE_BEGIN old words DELETE_END right\n" },
    expected: { "sentence.txt": "left  right\n" },
  },
);

add(
  "exact-range-copy",
  [
    "edit.whole-line-spans",
    "edit.copy-exact-range",
    "edit.copy-exact-destination",
    "edit.copy-source-range",
    "compose.search-range-endpoints",
  ],
  "First Search target.txt separately for TARGET_BEGIN and TARGET_END. Use the two actual :match references as objects {id: reference} in Copy targetFrom and targetThrough (in Codemode, pass the corresponding match values). Perform four transfers: (1) Copy the inline span in source.txt over that inclusive destination span in target.txt. Pass the literal strings COPY_BEGIN as from and COPY_END as through; do not use Search references or line anchors for these two source fields. (2) Copy the whole line 段🙂 from whole.txt, including its CRLF line break, over the exact SLOT fragment in inline.txt: pass the literal string 段🙂 followed by CRLF as at, and the literal string SLOT as targetAt. Issue transfers (1) and (2) together, direct in the same assistant message or in Codemode with Promise.all. (3) Copy that same whole.txt line, including its CRLF, so it becomes its own line after the ANCHOR line in inserted.txt: pass the same literal string 段🙂 followed by CRLF as at, and pass the literal string ANCHOR followed by LF as targetAfter. (4) Copy the same source line over the whole SLOT line in replaced.txt. Pass SLOT followed by LF as targetAt. Write only 段🙂 at the inline slot; use LF for the new lines in inserted.txt and replaced.txt. Leave both source files unchanged and preserve every byte outside the selected destination spans.",
  [
    { tool: "search", args: { path: "target.txt", query: "TARGET_BEGIN" } },
    { tool: "search", args: { path: "target.txt", query: "TARGET_END" } },
    {
      tool: "copy",
      args: {
        path: "source.txt",
        target: "target.txt",
        targetFrom: { id: matchReference(1) },
        targetThrough: { id: matchReference(1) },
      },
      exactText: ["from", "through"],
      reuse: [reuse(0, "targetFrom", "anchor"), reuse(1, "targetThrough", "anchor")],
    },
    {
      tool: "copy",
      sameAssistantWith: 2,
      args: {
        path: "whole.txt",
        at: "段🙂\r\n",
        target: "inline.txt",
      },
      exactText: ["at", "targetAt"],
    },
    {
      tool: "copy",
      args: {
        path: "whole.txt",
        at: "段🙂\r\n",
        target: "inserted.txt",
        targetAfter: "ANCHOR\n",
      },
      exactText: ["at"],
    },
    {
      tool: "copy",
      args: {
        path: "whole.txt",
        at: "段🙂\r\n",
        target: "replaced.txt",
        targetAt: "SLOT\n",
      },
      exactText: ["at", "targetAt"],
    },
  ],
  {
    files: {
      "source.txt": "source prefix COPY_BEGIN body COPY_END source suffix\n",
      "target.txt": "target prefix TARGET_BEGIN old TARGET_END target suffix\n",
      "whole.txt": "before\r\n段🙂\r\nafter\r\n",
      "inline.txt": "left SLOT right\n",
      "inserted.txt": "ANCHOR\nAFTER\n",
      "replaced.txt": "HEAD\nSLOT\nAFTER\n",
    },
    expected: {
      "source.txt": "source prefix COPY_BEGIN body COPY_END source suffix\n",
      "target.txt": "target prefix COPY_BEGIN body COPY_END target suffix\n",
      "whole.txt": "before\r\n段🙂\r\nafter\r\n",
      "inline.txt": "left 段🙂 right\n",
      "inserted.txt": "ANCHOR\n段🙂\nAFTER\n",
      "replaced.txt": "HEAD\n段🙂\nAFTER\n",
    },
  },
);

add(
  "exact-range-move",
  [
    "edit.move-exact-range",
    "edit.move-exact-destination",
    "edit.move-source-range",
    "compose.search-range-endpoints",
  ],
  "Search source.txt separately for MOVE_BEGIN and MOVE_END, then use their actual :match references (in Codemode, the ids of their matches) as Move from/through. Search target.txt separately for TARGET_BEGIN and TARGET_END. Prepare two independent Move calls. (1) Move the inline inclusive span from source.txt into target.txt using the destination :match references as objects {id: reference} in targetFrom/targetThrough (in Codemode, pass the match values). (2) Move the final block 段🙂 followed by 尾界 from eof.txt over the exact SLOT fragment in inline.txt, passing the literal string 段🙂 followed by CRLF and 尾界 as at, and the literal string SLOT as targetAt. Issue both Move calls together, direct in the same assistant message or in Codemode with Promise.all. Preserve the sentence text, surrounding spaces and CRLF endings in source.txt and target.txt. Preserve the moved block\u0027s internal CRLF in the LF destination. Leave only KEEP with no final line break in eof.txt. Do not use a whole-file move.",
  [
    { tool: "search", args: { path: "source.txt", query: "MOVE_BEGIN" } },
    { tool: "search", args: { path: "source.txt", query: "MOVE_END" } },
    { tool: "search", args: { path: "target.txt", query: "TARGET_BEGIN" } },
    { tool: "search", args: { path: "target.txt", query: "TARGET_END" } },
    {
      tool: "move",
      args: {
        path: "source.txt",
        from: matchReference(1),
        through: matchReference(1),
        target: "target.txt",
        targetFrom: { id: matchReference(1) },
        targetThrough: { id: matchReference(1) },
      },
      reuse: [
        reuse(0, "from", "anchor"),
        reuse(1, "through", "anchor"),
        reuse(2, "targetFrom", "anchor"),
        reuse(3, "targetThrough", "anchor"),
      ],
    },
    {
      tool: "move",
      sameAssistantWith: 4,
      args: {
        path: "eof.txt",
        target: "inline.txt",
      },
    },
  ],
  {
    files: {
      "source.txt": "source prefix MOVE_BEGIN body MOVE_END source suffix\r\n",
      "target.txt": "target prefix TARGET_BEGIN old TARGET_END target suffix\r\n",
      "eof.txt": "KEEP\r\n段🙂\r\n尾界",
      "inline.txt": "left SLOT right\n",
    },
    expected: {
      "source.txt": "source prefix  source suffix\r\n",
      "target.txt": "target prefix MOVE_BEGIN body MOVE_END target suffix\r\n",
      "eof.txt": "KEEP",
      "inline.txt": "left 段🙂\r\n尾界 right\n",
    },
  },
);

add(
  "exclusive-delete-transfer",
  ["edit.delete-exclusive-range", "edit.transfer-exclusive-range", "edit.transfer-insert-before"],
  "Delete the old line in delete.txt between the BEGIN and END marker lines, leaving both markers. Use after BEGIN and before END. Then copy the line fresh from source.txt using at fresh, replacing the range in target.txt between HEAD and TAIL: pass targetAfter HEAD and targetBefore TAIL to replace the old line while keeping both markers. Finally move the lines between BEGIN and END in move.txt, keeping the markers: pass after BEGIN and before END. Insert the moved line before TAIL in target.txt with targetBefore alone. Leave source.txt unchanged.",
  [
    { tool: "delete", args: { path: "delete.txt", after: "BEGIN", before: "END" } },
    {
      tool: "copy",
      args: {
        path: "source.txt",
        at: "fresh",
        target: "target.txt",
        targetAfter: "HEAD",
        targetBefore: "TAIL",
      },
    },
    {
      tool: "move",
      args: {
        path: "move.txt",
        after: "BEGIN",
        before: "END",
        target: "target.txt",
        targetAfter: undefined,
        targetBefore: "TAIL",
      },
      after: [1],
    },
  ],
  {
    files: {
      "delete.txt": "BEGIN\nold\nEND\n",
      "source.txt": "fresh\n",
      "target.txt": "HEAD\nold\nTAIL\n",
      "move.txt": "BEGIN\nmoved\nEND\n",
    },
    expected: {
      "delete.txt": "BEGIN\nEND\n",
      "target.txt": "HEAD\nfresh\nmoved\nTAIL\n",
      "move.txt": "BEGIN\nEND\n",
    },
  },
);

add(
  "mixed-range-replace",
  ["edit.mixed-range-endpoints"],
  "Read line-start.txt with anchors; each line is shown after its 7-character anchor and a |. Replace from the anchor shown before line 1 (pass it as from) through the exact END fragment on line 2 with NEW, passing the literal string END as through and preserving the suffix after END. Then Search line-end.txt for END. Replace from the exact START fragment on line 1 through that Search's :line reference (pass it as through) with NEW followed by a newline, passing the literal string START as from. Preserve the prefix before START and the last line. Each endpoint keeps its own extent: do not widen an exact endpoint because the other endpoint selects a whole line.",
  [
    { tool: "read", args: { path: "line-start.txt", views: ["anchors"] } },
    {
      tool: "replace",
      args: { path: "line-start.txt", from: /^[0-9A-HJKMNP-TV-Z]{7}$/u, through: "END" },
      reuse: reuse(0, "from", "anchor"),
    },
    { tool: "search", args: { path: "line-end.txt", query: "END" } },
    {
      tool: "replace",
      args: {
        path: "line-end.txt",
        from: "START",
        through: /^SEARCH#[A-F0-9]+:1:line$/u,
      },
      reuse: reuse(2, "through", "anchor"),
    },
  ],
  {
    // Line references exist only in readable results; a Codemode Search value has no line ids.
    modes: ["direct"],
    files: {
      "line-start.txt": "KEEP prefix START selected\nEND suffix KEEP\nlast\n",
      "line-end.txt": "KEEP prefix START selected\nEND suffix KEEP\nlast\n",
    },
    expected: {
      "line-start.txt": "NEW suffix KEEP\nlast\n",
      "line-end.txt": "KEEP prefix NEW\nlast\n",
    },
  },
);

add(
  "write-read",
  ["edit.write", "edit.write-receipt", "compose.write-read"],
  "Use write to create answer.txt containing exactly ready plus a newline. Pass the returned whole-file result into read, and report the saved value.",
  [
    {
      tool: "write",
      args: { path: "answer.txt" },
      contains: "Read the file",
      excludes: "ready\n",
    },
    { tool: "read", reuse: reuse(0), contains: "ready" },
  ],
  { expected: { "answer.txt": "ready\n" }, answer: "ready" },
);

add(
  "stale-whole-file-write",
  ["edit.stale-whole-file-write"],
  'Read all of shared.txt. Once Read returns, run Bash with command "printf \'task old\\npeer new\\n\' > shared.txt" to simulate a peer changing its second line. After Bash finishes, call Write with path shared.txt and content "task new\\npeer old\\n" (actual newline characters) without reading again. Write must refuse. Read shared.txt again after the refusal and confirm it contains task old and peer new; then Write "task new\\npeer new\\n" with real newline characters. Leave both changes in the file.',
  [
    { tool: "read", args: { path: "shared.txt" } },
    { tool: "bash", after: [0] },
    { tool: "write", args: { path: "shared.txt" }, error: true, after: [1] },
    { tool: "read", args: { path: "shared.txt" }, contains: "peer new", after: [2] },
    { tool: "write", args: { path: "shared.txt" }, after: [3] },
  ],
  {
    files: { "shared.txt": "task old\npeer old\n" },
    expected: { "shared.txt": "task new\npeer new\n" },
  },
);
add(
  "write-hook-read",
  ["edit.write-hook-feedback", "compose.write-hook-read"],
  "Write review.txt containing exactly WRITE_HOOK_BODY review plus a newline. Report the saved-check hook's remark from the compact Write receipt, or in Codemode from the script's result, then pass that unchanged Write result into Read and report the saved value. Do not treat the remark as a failed or interrupted write.",
  [
    {
      tool: "write",
      args: { path: "review.txt" },
      contains: "Saved edit needs review",
      excludes: "WRITE_HOOK_BODY",
    },
    { tool: "read", reuse: reuse(0), contains: "WRITE_HOOK_BODY review" },
  ],
  {
    setup: "write-hook",
    expected: { "review.txt": "WRITE_HOOK_BODY review\n" },
    answer: "Saved edit needs review",
  },
);
add(
  "write-silent",
  ["codemode.silent-write"],
  "In one Codemode script, await write to create silent.txt containing exactly SILENT_WRITE_BODY plus a newline. Do not print, return, or log the Write result. Finish the script without output, then report completion.",
  [
    {
      tool: "write",
      args: { path: "silent.txt", content: "SILENT_WRITE_BODY\n" },
      parentExcludes: "SILENT_WRITE_BODY",
    },
  ],
  { modes: ["codemode"], expected: { "silent.txt": "SILENT_WRITE_BODY\n" } },
);

add(
  "whole-file-script-receipts",
  ["codemode.whole-file-receipts"],
  "In one Codemode script, write saved.txt containing exactly RECEIPT_BODY plus a newline, copy copy-source.txt to copy-target.txt, then move move-source.txt to move-target.txt. Await each operation, and do not print, return, or log their values. Finish the script without output. Report completion from the script result.",
  [
    {
      tool: "write",
      args: { path: "saved.txt" },
      parentContains: "saved.txt",
      parentExcludes: "RECEIPT_BODY",
    },
    {
      tool: "copy",
      args: { path: "copy-source.txt", target: "copy-target.txt" },
      parentContains: "copy-target.txt",
      parentExcludes: "RECEIPT_BODY",
    },
    {
      tool: "move",
      args: { path: "move-source.txt", target: "move-target.txt" },
      parentContains: "move-target.txt",
      parentExcludes: "RECEIPT_BODY",
    },
  ],
  {
    modes: ["codemode"],
    files: { "copy-source.txt": "copy body\n", "move-source.txt": "move body\n" },
    expected: {
      "saved.txt": "RECEIPT_BODY\n",
      "copy-source.txt": "copy body\n",
      "copy-target.txt": "copy body\n",
      "move-source.txt": null,
      "move-target.txt": "move body\n",
    },
  },
);

add(
  "write-large-read",
  ["compose.write-large-read"],
  "Use one Codemode script to write large.txt with exactly 1024 copies of retained line followed by a newline (use repeat). Pass the returned Write result directly into Read with offset 1024 and limit 1. Print that Read result and report its last-line value. Do not shorten the saved content to match a display preview.",
  [
    { tool: "write", args: { path: "large.txt" } },
    { tool: "read", args: { offset: 1024, limit: 1 }, reuse: reuse(0), contains: "retained line" },
  ],
  {
    modes: ["codemode"],
    expected: { "large.txt": "retained line\n".repeat(1024) },
    answer: "retained line",
  },
);

add(
  "replace-read-search",
  ["edit.replace-exact", "compose.mutation-read", "compose.mutation-search"],
  "Use Replace, then use its result for Read and Search. Use replace on task.txt, passing the literal string OLD as at and NEW as text. Pass the mutation result to read (this read is required), then search within that same mutation result for NEW. Keep everything else.",
  [
    { tool: "replace", args: { path: "task.txt" }, exactText: ["at"] },
    { tool: "read", reuse: reuse(0), contains: "NEW" },
    { tool: "search", args: { query: "NEW" }, reuse: reuse(0), contains: "NEW" },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

add(
  "insert-before",
  ["edit.insert-before", "edit.insert-spacing", "edit.insert-exact-boundaries"],
  "Use Insert before the exact OLD line in task.txt to add a separate paragraph NOTE with blank-line separation. Then insert [ immediately before and ] immediately after the exact α🙂 fragment in literal.txt, passing the literal string α🙂 as before for [ and as after for ]. Do the same around the multiline α followed by β fragment in block.txt, preserving its CRLF and the surrounding words. Pass the literal string α followed by CRLF followed by β as before for [ and as after for ]. Pass actual newline characters in multiline anchors; do not paste printed line-anchor prefixes. Finally Search search.txt for MATCH and use its actual :match reference (in Codemode, the id of its match) as before to add [ immediately before that fragment. Search again after this change and use the fresh :match reference or match id as after to insert ] immediately after MATCH. Use ordinary line separation for the exact-fragment edits; add no new line breaks in those edits. Preserve all other bytes.",
  [
    {
      tool: "insert",
      args: {
        before: "OLD",
        separation: "blank-line",
      },
    },
    {
      tool: "insert",
      args: { path: "literal.txt" },
      exactText: ["before"],
    },
    {
      tool: "insert",
      args: { path: "literal.txt" },
      exactText: ["after"],
    },
    {
      tool: "insert",
      args: { path: "block.txt" },
      exactText: ["before"],
    },
    {
      tool: "insert",
      args: { path: "block.txt" },
      exactText: ["after"],
    },
    { tool: "search", args: { path: "search.txt", query: "MATCH" } },
    {
      tool: "insert",
      args: {
        path: "search.txt",
        before: matchReference(1),
      },
      reuse: reuse(5, "before", "anchor"),
    },
    { tool: "search", args: { path: "search.txt", query: "MATCH" } },
    {
      tool: "insert",
      args: {
        path: "search.txt",
        after: matchReference(1),
      },
      reuse: reuse(7, "after", "anchor"),
    },
  ],
  {
    files: {
      ...textFile,
      "literal.txt": "left α🙂 right\n",
      "block.txt": "left α\r\nβ right\r\n",
      "search.txt": "left MATCH right\n",
    },
    expected: {
      "task.txt": "keep\n\nNOTE\n\nOLD\nlast\n",
      "literal.txt": "left [α🙂] right\n",
      "block.txt": "left [α\r\nβ] right\r\n",
      "search.txt": "left [MATCH] right\n",
    },
  },
);

add(
  "delete-selection",
  ["edit.whole-line-spans", "edit.delete-selection", "compose.search-delete"],
  "Search task.txt for the exact OLD fragment. Pass that Search result into Delete. Remove the whole OLD line with no empty line left.",
  [
    { tool: "search", args: { path: "task.txt", query: "OLD" } },
    { tool: "delete", reuse: reuse(0) },
  ],
  { expected: { "task.txt": "keep\nlast\n" } },
);

const declarationFiles = {
  "task.ts":
    'import { value } from "./helper";\nexport function doomed() { return value; }\nexport const label = "doomed";\n',
  "helper.ts": "export const value = 1;\n",
  "consumer.ts": 'import { doomed } from "./task";\nexport const result = doomed();\n',
  "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
};
const deletedDeclaration = {
  ...declarationFiles,
  "task.ts": 'import { value } from "./helper";\n\nexport const label = "doomed";\n',
};

add(
  "read-symbol-delete",
  ["edit.delete-declaration", "compose.symbol-read-delete"],
  "Use lsp_search with declaration task.ts#doomed, then pass its unchanged result or UUID (in Codemode, its value or its one match) to delete without start/end. Keep the source file, imports, the label string, and every reference unchanged. Do not reconstruct a path for Delete.",
  [
    { tool: "lsp_search", args: { declaration: "task.ts#doomed" }, contains: "function doomed" },
    {
      tool: "delete",
      args: {
        at: undefined,
        from: undefined,
        after: undefined,
        through: undefined,
        before: undefined,
      },
      reuse: reuse(0),
    },
  ],
  {
    files: declarationFiles,
    expected: {
      ...deletedDeclaration,
      "task.ts": 'import { value } from "./helper";\nexport const label = "doomed";\n',
    },
    prerequisite: "command -v typescript-language-server",
  },
);

const rejectionFiles = {
  "task.ts": "export class First { ping() {} }\nexport class Second { ping() {} }\n",
  "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
};
add(
  "reject-lsp-declaration",
  ["lsp.declaration-refusals"],
  "Ask lsp_search for declaration task.ts, task.ts#missing and task.ts#ping. Each must refuse its invalid, missing or ambiguous declaration selector. Do not edit or delete anything; keep all files unchanged.",
  ["task.ts", "task.ts#missing", "task.ts#ping"].map((declaration) => ({
    tool: "lsp_search",
    args: { declaration },
    error: true,
  })),
  {
    files: rejectionFiles,
    expected: rejectionFiles,
    prerequisite: "command -v typescript-language-server",
  },
);

add(
  "mixed-file-delete-text-edit",
  ["compose.file-delete-text-edit"],
  (api) =>
    `${parallelCalls(api, 4)} Include one Insert and three whole-file Deletes. Use Insert with path note.txt, anchor keep and text ${JSON.stringify("ADDED\n")} (a trailing newline). Delete a.txt, b.txt and c.txt by ordinary paths without start/end. Keep note.txt and its other bytes; do not turn the file deletions into text selections.`,
  [
    { tool: "insert", args: { path: "note.txt", after: "keep", text: "ADDED\n" } },
    ...["a.txt", "b.txt", "c.txt"].map((source): RouteStep => ({
      tool: "delete",
      args: {
        path: source,
        at: undefined,
        from: undefined,
        after: undefined,
        through: undefined,
        before: undefined,
      },
      sameAssistantWith: 0,
    })),
  ],
  {
    modes: ["direct"],
    files: {
      "note.txt": "keep\nnext\n",
      "a.txt": "remove\n",
      "b.txt": "remove\n",
      "c.txt": "remove\n",
    },
    expected: { "note.txt": "keep\nADDED\nnext\n", "a.txt": null, "b.txt": null, "c.txt": null },
  },
);

add(
  "file-copy-move-delete",
  ["edit.copy-file", "edit.move-file", "edit.delete-file", "edit.whole-file-omission"],
  "First use move with task.txt as both path and target; it must report not-applied. Then use copy to duplicate task.txt into copied.txt, move copied.txt to moved.txt, then delete moved.txt. Use ordinary file paths for these whole-file operations, without start/end or destination selection arguments. The original must stay unchanged.",
  [
    {
      tool: "move",
      args: {
        path: "task.txt",
        target: "task.txt",
        at: undefined,
        from: undefined,
        after: undefined,
        through: undefined,
        before: undefined,
        targetAt: undefined,
        targetFrom: undefined,
        targetAfter: undefined,
        targetThrough: undefined,
        targetBefore: undefined,
      },
      error: true,
      contains: "move: not-applied",
    },
    {
      tool: "copy",
      args: {
        path: "task.txt",
        target: "copied.txt",
        at: undefined,
        from: undefined,
        after: undefined,
        through: undefined,
        before: undefined,
        targetAt: undefined,
        targetFrom: undefined,
        targetAfter: undefined,
        targetThrough: undefined,
        targetBefore: undefined,
      },
    },
    {
      tool: "move",
      args: {
        path: "copied.txt",
        target: "moved.txt",
        at: undefined,
        from: undefined,
        after: undefined,
        through: undefined,
        before: undefined,
        targetAt: undefined,
        targetFrom: undefined,
        targetAfter: undefined,
        targetThrough: undefined,
        targetBefore: undefined,
      },
      contains: "move: applied",
    },
    {
      tool: "delete",
      args: {
        path: "moved.txt",
        at: undefined,
        from: undefined,
        after: undefined,
        through: undefined,
        before: undefined,
      },
    },
  ],
  { expected: { "task.txt": textFile["task.txt"], "copied.txt": null, "moved.txt": null } },
);

add(
  "write-confirmed-readback",
  ["edit.write-canonicalized-snapshot", "compose.confirmed-write-readback"],
  "Write changed plus a newline once to fixture://saved-canonicalized/content. This provider stores uppercase text, so the successful result and a fresh Read must expose CHANGED rather than the submitted text. Wait for that Write result before the fresh Read. Both resources share the same stored body: wait for this Read result before the second Write so it still observes CHANGED. Write updated plus a newline once to fixture://saved-readback/content. This provider acknowledges persistence but cannot read the saved body on that resource instance. Preserve its applied effect, expect the post-write readback error (null in Codemode), and wait for that failed Write result before reading the explicit resource freshly to inspect updated. Never replay either write; report saved for the second one, not unknown delivery.",
  [
    {
      tool: "write",
      args: { path: "fixture://saved-canonicalized/content" },
      contains: "CHANGED",
    },
    {
      tool: "read",
      args: { path: "fixture://saved-canonicalized/content" },
      contains: "CHANGED",
      after: [0],
    },
    {
      tool: "write",
      args: { path: "fixture://saved-readback/content" },
      after: [1],
      error: true,
      contains: "READBACK",
      excludes: "Write outcome unknown.",
    },
    {
      tool: "read",
      args: { path: "fixture://saved-readback/content" },
      contains: "updated",
      after: [2],
    },
  ],
  {
    setup: "write-effects",
    files: { "saved.md": "before\n" },
    expected: {
      "saved.md": "updated\n",
      "attempts.jsonl": '{"content":"changed\\n"}\n{"content":"updated\\n"}\n',
    },
    answer: "saved",
  },
);
// Optional closed provider metadata does not change this effect/readback route.
// Write metadata projection is checked by deterministic resource-failure and structured-result tests.
add(
  "write-unknown-effects",
  ["edit.write-failure-recovery", "compose.uncertain-write-read"],
  "Write changed plus a newline to fixture://saved-mismatch/content. This isolated provider saves the bytes and then returns PROVIDER_SAVE_VERIFICATION_FAILED with unknown effects. Do not call this an unapplied write and do not replay it. After the failed Write result returns, Read the same explicit resource to inspect saved text, then report that the write effect is unknown. In Codemode, the failed Write resolves to null and the Read still runs. This headless case checks recovery, not the TUI failure panel.",
  [
    {
      tool: "write",
      args: { path: "fixture://saved-mismatch/content" },
      error: true,
      contains: "PROVIDER_SAVE_VERIFICATION_FAILED",
      excludes: "No file was changed.",
    },
    {
      tool: "read",
      args: { path: "fixture://saved-mismatch/content" },
      after: [0],
      contains: "changed",
    },
  ],
  {
    setup: "write-effects",
    files: { "saved.md": "before\n" },
    expected: { "saved.md": "changed\n", "attempts.jsonl": '{"content":"changed\\n"}\n' },
    answer: "unknown",
  },
);
add(
  "move-unknown-effects",
  ["edit.move-effects"],
  "Use whole-file move on .tmp/move-effects/unknown-after.txt to .tmp/move-effects/unknown-after-target.txt. This isolated fixture deliberately fails after execution starts. Preserve the unknown effect: do not call it not-applied and do not retry. After the failed Move result returns, Read the destination by its ordinary path to inspect the bytes and report that the Move effect is unknown. In Codemode, the failed call resolves to null and the inspection still runs.",
  [
    {
      tool: "move",
      args: {
        path: ".tmp/move-effects/unknown-after.txt",
        target: ".tmp/move-effects/unknown-after-target.txt",
      },
      error: true,
      contains: "move: unknown",
    },
    {
      tool: "read",
      args: { path: ".tmp/move-effects/unknown-after-target.txt" },
      after: [0],
      contains: "MOVED-BYTES",
    },
  ],
  {
    setup: "move-effects",
    files: {
      ".tmp/move-effects/owned.txt": "LPT-642 disposable fixtures\n",
      ".tmp/move-effects/unknown-after.txt": "MOVED-BYTES\n",
      ".tmp/move-effects/unknown-after-target.txt": "old target\n",
    },
    expected: {
      ".tmp/move-effects/unknown-after.txt": null,
      ".tmp/move-effects/unknown-after-target.txt": "MOVED-BYTES\n",
    },
    answer: "unknown",
  },
);

add(
  "copy-destination-recovery",
  ["edit.copy-destination-recovery"],
  "Exercise Copy destination recovery in task.txt. First Copy with path task.txt, from alpha, through beta and targetAfter equal to the ambiguous text });, and wait for the refusal. Copy the same alpha-through-beta block after INSERT_HERE using the destination anchor printed in the refusal's context, not a separate Read. Keep the source selection unchanged. The rejected call must leave the file unchanged and the corrected call must copy the block exactly once.",
  [
    {
      tool: "copy",
      args: { path: "task.txt", targetAfter: "});" },
      error: true,
    },
    {
      tool: "copy",
      args: {
        path: "task.txt",
        targetAfter: /^[0-9A-HJKMNP-TV-Z]{7}(?:\|[^\r\n]*(?:\r?\n)?)?$/u,
      },
      reuse: reuse(0, "targetAfter", "anchor"),
      after: [0],
    },
  ],
  {
    files: { "task.txt": "alpha\nbeta\ngap\n});\nINSERT_HERE\n});\ntail\n" },
    expected: {
      "task.txt": "alpha\nbeta\ngap\n});\nINSERT_HERE\nalpha\nbeta\n});\ntail\n",
    },
  },
);
add(
  "move-destination-recovery",
  ["edit.move-destination-recovery"],
  "First call Move on task.txt with at set explicitly to the empty string and targetAfter set to second marker, and wait for the empty selector refusal. Then call Move on task.txt with the exact text move this followed by its line break as at and the misspelled second makrer as targetAfter. Retry the same Move, changing only targetAfter to the anchor for the second marker line printed in the refusal. Move the line exactly once. Once that Move succeeds, replace the exact text keep this with kept. Preserve every other line. In Codemode, wait for the result of each call before the next.",
  [
    {
      tool: "move",
      args: { path: "task.txt", at: "", targetAfter: "second marker" },
      error: true,
      contains: "EMPTY_SELECTOR",
    },
    {
      tool: "move",
      args: { path: "task.txt", at: "move this\n", targetAfter: "second makrer" },
      after: [0],
      error: true,
      exactText: ["at", "targetAfter"],
    },
    {
      tool: "move",
      args: {
        path: "task.txt",
        at: "move this\n",
        targetAfter: /^[0-9A-HJKMNP-TV-Z]{7}(?:\|[^\r\n]*(?:\r?\n)?)?$/u,
      },
      exactText: ["at"],
      reuse: reuse(1, "targetAfter", "anchor"),
      after: [1],
    },
    {
      tool: "replace",
      args: { path: "task.txt", at: "keep this", text: "kept" },
      after: [2],
    },
  ],
  {
    files: { "task.txt": "header\nmove this\nkeep this\nfirst marker\nsecond marker\ntail\n" },
    expected: { "task.txt": "header\nkept\nfirst marker\nsecond marker\nmove this\ntail\n" },
  },
);
add(
  "selection-copy-move",
  [
    "edit.copy-selection",
    "edit.move-selection",
    "edit.copy-source-range",
    "edit.move-source-range",
    "compose.read-window-copy",
    "compose.read-window-move",
  ],
  "Read only the second line of task.txt (offset 2, limit 1). Copy that Read result to dest.txt with the literal DEST followed by LF as targetAfter. Read the second line of task.txt again and Move that result to dest.txt with the literal TAIL followed by LF as targetAfter. Then Read only the second line of copy-source.txt (offset 2, limit 1). Copy that returned window over only COPY_SLOT in copy-replaced.txt using targetAt, then copy the same window after the exact fragment COPY_POINT in copy-inserted.txt with targetAfter. Read two lines from move-replace-source.txt (offset 2, limit 2) and move that window over only MOVE_SLOT in move-replaced.txt using targetAt. Read two lines from move-insert-source.txt the same way and move that window after the exact fragment MOVE_POINT in move-inserted.txt with targetAfter. Pass each returned Read result or its UUID unchanged as the source. Preserve the selected Unicode bytes, the CRLF between selected lines in these LF destinations, and the surrounding destination text.",
  [
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } },
    {
      tool: "copy",
      args: { target: "dest.txt", targetAfter: "DEST\n" },
      exactText: ["targetAfter"],
      reuse: reuse(0),
    },
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } },
    {
      tool: "move",
      args: { target: "dest.txt", targetAfter: "TAIL\n" },
      exactText: ["targetAfter"],
      reuse: reuse(2),
    },
    { tool: "read", args: { path: "copy-source.txt", offset: 2, limit: 1 } },
    {
      tool: "copy",
      args: {
        target: "copy-replaced.txt",
        targetAt: "COPY_SLOT",
      },
      reuse: reuse(4),
    },
    {
      tool: "copy",
      args: {
        target: "copy-inserted.txt",
        targetAfter: "COPY_POINT",
      },
      reuse: reuse(4),
    },
    { tool: "read", args: { path: "move-replace-source.txt", offset: 2, limit: 2 } },
    {
      tool: "move",
      args: {
        target: "move-replaced.txt",
        targetAt: "MOVE_SLOT",
      },
      reuse: reuse(7),
    },
    { tool: "read", args: { path: "move-insert-source.txt", offset: 2, limit: 2 } },
    {
      tool: "move",
      args: {
        target: "move-inserted.txt",
        targetAfter: "MOVE_POINT",
      },
      reuse: reuse(9),
    },
  ],
  {
    files: {
      ...textFile,
      "dest.txt": "DEST\nTAIL\n",
      "copy-source.txt": "keep\r\n段🙂\r\nafter\r\n",
      "copy-replaced.txt": "left COPY_SLOT right\n",
      "copy-inserted.txt": "left COPY_POINT right\n",
      "move-replace-source.txt": "keep\r\n段🙂\r\n尾🙂",
      "move-replaced.txt": "left MOVE_SLOT right\n",
      "move-insert-source.txt": "keep\r\n段🙂\r\n尾🙂",
      "move-inserted.txt": "left MOVE_POINT right\n",
    },
    expected: {
      "task.txt": "keep\nlast\n",
      "dest.txt": "DEST\nOLD\nTAIL\nOLD\n",
      "copy-source.txt": "keep\r\n段🙂\r\nafter\r\n",
      // A window of whole lines carries their content without the last line's ending.
      "copy-replaced.txt": "left 段🙂 right\n",
      "copy-inserted.txt": "left COPY_POINT段🙂 right\n",
      // Removing final lines without a final line break also removes the ending before them.
      "move-replace-source.txt": "keep",
      "move-replaced.txt": "left 段🙂\r\n尾🙂 right\n",
      "move-insert-source.txt": "keep",
      "move-inserted.txt": "left MOVE_POINT段🙂\r\n尾🙂 right\n",
    },
  },
);

for (const scenario of ["restored", "target-failed", "target-failed-after-restore"] as const) {
  const source = `.tmp/move-rollback/${scenario}-source.txt`;
  const target = `.tmp/move-rollback/${scenario}-target.txt`;
  const restored = scenario === "restored";
  add(
    `move-rollback-${scenario}`,
    ["edit.move-rollback"],
    `Move from path ${source} with at move-me and target ${target} with targetAfter top. The isolated fixture injects a write failure. Do not retry or repair the Move. Inspect its final failure result (including the final parent result on Codemode), then Read the source and the destination in two separate later calls. For the Codemode route, call tools.move inside a script, wait for that script's final parent result, then call tools.read for each file in its own later Codemode call. Keep any extra inspection inside Codemode. Report ${restored ? "restored" : "unknown"} for the destination's reported effect and explain why. A rejected rollback cannot prove final bytes, even if a later Read finds the original text.`,
    [
      {
        tool: "move",
        error: "direct",
        args: {
          path: source,
          target,
        },
      },
      { tool: "read", args: { path: source }, contains: "move-me", after: [0] },
      { tool: "read", args: { path: target }, contains: "bottom", after: [0] },
    ],
    {
      setup: "move-rollback",
      files: { [source]: "head\nmove-me\nend\n", [target]: "top\nbottom\n" },
      expected: {
        [target]: scenario === "target-failed" ? "top\nmove-me\nbottom\n" : "top\nbottom\n",
      },
      answer: restored ? "restored" : "unknown",
    },
  );
}

add(
  "paired-copy",
  ["compose.paired-sources-targets"],
  "Read a.txt and b.txt in separate calls. Also read dest-a.txt and dest-b.txt. For the Codemode route, make these individual tools.read calls inside Codemode; independent reads may share a script. Call tools.copy inside Codemode too. Use copy with the a.txt and b.txt Read results as the path array and the dest-a.txt and dest-b.txt Read results as the target array, in those orders, replacing both whole destination files.",
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
  "move-empty",
  ["edit.move-empty"],
  'Search task.txt and dest.txt separately with query "ABSENT" to get two empty results. Pass both unchanged results as Move\'s source and target. It must succeed without changes. Search the unchanged Move result with query "source"; it must find nothing. Do not edit any file.',
  [
    { tool: "search", args: { path: "task.txt", query: "ABSENT" } },
    { tool: "search", args: { path: "dest.txt", query: "ABSENT" } },
    { tool: "move", reuse: [reuse(0), reuse(1, "target")], contains: "no changes" },
    { tool: "search", args: { query: "source" }, reuse: reuse(2), contains: "No matches found" },
  ],
  {
    files: { "task.txt": "source\n", "dest.txt": "destination\n" },
    expected: { "task.txt": "source\n", "dest.txt": "destination\n" },
  },
);
add(
  "move-zero-width",
  ["edit.move-zero-width", "compose.move-point-replace", "compose.value-id-source"],
  'Search task.txt with query regex:^. Search dest.txt with query regex:(?<=^left ) for the point directly after "left " (character offset 5). Move the source point to the destination point using both unchanged Search results as path and target. In Codemode, pass the entire returned Search values unchanged, without extracting ids or matches. Move must succeed with no changes. Pass the unchanged Move result into replace with text NEW followed by one space. Only dest.txt should become left NEW right followed by its original newline.',
  [
    { tool: "search", args: { path: "task.txt", query: /^regex:/ } },
    { tool: "search", args: { path: "dest.txt", query: /^regex:/ } },
    {
      tool: "move",
      reuse: [reuse(0), reuse(1, "target")],
      contains: "No changes: zero-width selections.",
    },
    { tool: "replace", reuse: reuse(2) },
  ],
  {
    files: { "task.txt": "source\n", "dest.txt": "left right\n" },
    expected: { "task.txt": "source\n", "dest.txt": "left NEW right\n" },
  },
);

add(
  "whole-line-move-to-point",
  ["edit.whole-line-spans"],
  "Read only line 1 of task.txt (offset 1, limit 1). Search dest.txt with query regex:^(?=target) for the exact point at the start of its first line. Move the retained Read result to that point. Pass the Read result or its id as path and the unchanged Search result or its id as target. Omit selectors. The moved line must stay separate and take the destination line ending.",
  [
    { tool: "read", args: { path: "task.txt", offset: 1, limit: 1 } },
    { tool: "search", args: { path: "dest.txt", query: "regex:^(?=target)" } },
    {
      tool: "move",
      args: {
        at: undefined,
        from: undefined,
        after: undefined,
        through: undefined,
        before: undefined,
        targetAt: undefined,
        targetFrom: undefined,
        targetAfter: undefined,
        targetThrough: undefined,
        targetBefore: undefined,
      },
      reuse: [reuse(0), reuse(1, "target")],
    },
  ],
  {
    files: { "task.txt": "block\nkeep\n", "dest.txt": "target\r\nafter\r\n" },
    expected: { "task.txt": "keep\n", "dest.txt": "block\r\ntarget\r\nafter\r\n" },
  },
);

add(
  "read-diff",
  ["read.diff", "compose.read-diff"],
  "Read a.txt and b.txt separately. Pass their unchanged results or UUIDs as before and after to diff. Report the added line. Do not edit files.",
  [
    { tool: "read", args: { path: "a.txt" } },
    { tool: "read", args: { path: "b.txt" } },
    {
      tool: "diff",
      reuse: [reuse(0, "before"), reuse(1, "after")],
      contains: "NEW",
      scriptResult: /\n-OLD\n\+NEW$/u,
    },
  ],
  { files: { "a.txt": "OLD\n", "b.txt": "NEW\n" }, answer: "NEW" },
);

add(
  "diff-omission",
  ["read.diff-omission"],
  "Compare a.txt and b.txt with diff using before/after objects that contain only path. Omit offset and limit to compare the complete files and report the added line. Then diff the same files again with explicit limit 0 on both objects; that comparison must expose no file lines. Do not edit either file.",
  [
    {
      tool: "diff",
      args: {
        before: { path: "a.txt", offset: undefined, limit: undefined },
        after: { path: "b.txt", offset: undefined, limit: undefined },
      },
      contains: "NEW",
      scriptResult: /\n-OLD\n\+NEW$/u,
    },
    {
      tool: "diff",
      args: {
        before: { path: "a.txt", offset: undefined, limit: 0 },
        after: { path: "b.txt", offset: undefined, limit: 0 },
      },
      excludes: "NEW",
    },
  ],
  {
    files: { "a.txt": "OLD\n", "b.txt": "NEW\n" },
    expected: { "a.txt": "OLD\n", "b.txt": "NEW\n" },
    answer: "NEW",
  },
);

const addedRows = Array.from({ length: 2500 }, (_, index) => `row ${index}\n`).join("");
add(
  "diff-script-complete",
  ["codemode.diff-complete"],
  'In one Codemode script, diff before.txt against after.txt; after.txt has more lines than a tool result shows. Without printing the diff, count the lines of the returned string that start with "+" but not with "+++", and report that count in plain digits. Then diff before.txt against itself and check that the result is an empty string. Do not use Bash, the raw: prefix or temporary results, and do not edit files.',
  [
    {
      tool: "diff",
      scriptResult:
        /^--- \S*before\.txt\n\+\+\+ \S*after\.txt\n@@ -1,1 \+1,2501 @@\n head\n\+row 0\n[\s\S]*\n\+row 2499$/u,
    },
    { tool: "diff", scriptResult: "" },
  ],
  {
    modes: ["codemode"],
    files: { "before.txt": "head\n", "after.txt": `head\n${addedRows}` },
    expected: { "before.txt": "head\n", "after.txt": `head\n${addedRows}` },
    answer: "2500",
  },
);

for (const [name, eol] of [
  ["lf", "\n"],
  ["crlf", "\r\n"],
] as const) {
  add(
    `replace-line-boundary-${name}`,
    ["edit.whole-line-spans", "edit.replace-line-endings"],
    `In heading.txt, replace the literal ${JSON.stringify("## OLD" + eol)} with ## NEW and no newline, preserving the blank line before Body. In blank-one.txt replace the literal ${JSON.stringify("OLD" + eol)} with one LF character. In blank-two.txt replace the literal OLD without its ending with two LF characters. The last two edits must leave one and two empty lines respectively, in each file's existing line-ending style. Decode the JSON escapes as actual line breaks. Use literal at strings.`,
    [
      {
        tool: "replace",
        args: {
          path: "heading.txt",
          at: `## OLD${eol}`,
          text: "## NEW",
          through: undefined,
          before: undefined,
        },
        exactText: ["at"],
      },
      {
        tool: "replace",
        args: {
          path: "blank-one.txt",
          at: `OLD${eol}`,
          text: "\n",
          through: undefined,
          before: undefined,
        },
        exactText: ["at"],
      },
      {
        tool: "replace",
        args: {
          path: "blank-two.txt",
          at: "OLD",
          text: "\n\n",
          through: undefined,
          before: undefined,
        },
        exactText: ["at"],
      },
    ],
    {
      files: {
        "heading.txt": `## OLD${eol}${eol}Body${eol}`,
        "blank-one.txt": `keep${eol}OLD${eol}last${eol}`,
        "blank-two.txt": `keep${eol}OLD${eol}last${eol}`,
      },
      expected: {
        "heading.txt": `## NEW${eol}${eol}Body${eol}`,
        "blank-one.txt": `keep${eol}${eol}last${eol}`,
        "blank-two.txt": `keep${eol}${eol}${eol}last${eol}`,
      },
    },
  );
}
add(
  "hash-shaped-literal",
  ["edit.hash-shaped-literal"],
  'Read task.txt with anchors. Delete only PACKAGE and its following newline using the exact literal string "PACKAGE\\n" as at (decode the JSON escape to an actual newline). Do not use a line anchor or Search reference. Preserve First and Last.',
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    {
      tool: "delete",
      args: { path: "task.txt", at: "PACKAGE\n" },
      exactText: ["at"],
      after: [0],
    },
  ],
  { files: { "task.txt": "First\nPACKAGE\nLast\n" }, expected: { "task.txt": "First\nLast\n" } },
);
for (const [name, eol, ending] of [
  ["lf", "\n", "\n"],
  ["crlf", "\r\n", "\r\n"],
  ["unterminated", "\n", ""],
] as const) {
  add(
    `exact-eof-${name}`,
    ["edit.whole-line-spans", "edit.exact-eof", "edit.delete-empty-replace"],
    `In last.txt, use Replace with the literal string Last as at and Final as text. Do not use an issued reference or line anchor for this replacement. Delete the exact final block Last followed by Block in block.txt. Remove the identical final block in empty.txt using Replace with empty text. For the two block edits, pass the literal string ${JSON.stringify(`Last${eol}Block${ending}`)} as at for Delete and at for Replace. Decode the JSON escapes as actual line-separator characters; do not pass Search references or line anchors for these block edits. Read line.txt with anchors, then Delete only its final Last line using the actual returned line anchor. In blank.txt, replace the literal string Last with a single LF character using at. Preserve the preceding First line in every file. Keep unrelated bytes and each file's existing newline style.`,
    [
      {
        tool: "replace",
        args: { path: "last.txt", text: "Final", through: undefined, before: undefined },
        exactText: ["at"],
      },
      {
        tool: "delete",
        args: { path: "block.txt", through: undefined, before: undefined },
        exactText: ["at"],
      },
      {
        tool: "replace",
        args: { path: "empty.txt", text: "", through: undefined, before: undefined },
        exactText: ["at"],
      },
      { tool: "read", args: { path: "line.txt", views: ["anchors"] } },
      {
        tool: "delete",
        args: { path: "line.txt" },
        reuse: reuse(3, ["path", "at"], "anchor"),
      },
      {
        tool: "replace",
        args: { path: "blank.txt", at: "Last", text: "\n", through: undefined, before: undefined },
        exactText: ["at"],
      },
    ],
    {
      files: {
        "last.txt": `First${eol}Last${ending}`,
        "block.txt": `First${eol}Last${eol}Block${ending}`,
        "empty.txt": `First${eol}Last${eol}Block${ending}`,
        "line.txt": `First${eol}Last${ending}`,
        "blank.txt": `First${eol}Last${ending}`,
      },
      expected: {
        "last.txt": `First${eol}Final${ending}`,
        // LPT-1747: deleting whole lines at an unterminated EOF also removes the preceding break.
        "block.txt": `First${ending}`,
        "empty.txt": `First${ending}`,
        "line.txt": `First${ending}`,
        "blank.txt": `First${eol}${ending}`,
      },
    },
  );
}
add(
  "replace-lookalike-bytes",
  ["edit.replace-lookalike-bytes"],
  "Read routes.ts with anchors. Use Replace with the actual returned line anchor of its last line as at and the text export default routeTable; written with plain ASCII spaces. Keep every other byte of the file, including characters that look like spaces, quotes or dashes. Do not use literal text as at.",
  [
    { tool: "read", args: { path: "routes.ts", views: ["anchors"] } },
    {
      tool: "replace",
      args: {
        path: "routes.ts",
        text: "export default routeTable;",
        through: undefined,
        before: undefined,
      },
      reuse: reuse(0, ["path", "at"], "anchor"),
    },
  ],
  {
    files: { "routes.ts": "// \u201Croutes\u201D \u2013 table\nexport\u00A0default routes;\n" },
    expected: {
      "routes.ts": "// \u201Croutes\u201D \u2013 table\nexport\u00A0default routeTable;\n",
    },
  },
);
for (const method of ["all", "allSettled"] as const) {
  add(
    `parallel-edit-effects-${method}`,
    ["codemode.parallel-edit-effects", "compose.read-concurrent-edit-snapshot"],
    `In one native Codemode script, first Read insert.txt and delete.txt separately with the anchors view and retain both returned values. Then use one Promise.${method} to start six edits together, without awaiting an individual edit first. For the first two Inserts, pass the same unchanged insert Read value as path: insert FIRST plus a newline after first and MIDDLE plus a newline after middle. For the third Insert, pass "./insert.txt" as path and insert LAST plus a newline after last. For the first two Deletes, pass the same unchanged delete Read value as path: delete the unique whole lines first and middle. For the third Delete, pass "./delete.txt" as path and delete last. Use the corresponding line anchors from the Reads. Print every value: each Insert resolves to the id of its inserted text and each Delete to null; the script result lists any failed call. Preserve all other bytes, including the existing blank lines and EOF.`,
    [
      { tool: "read", args: { path: "insert.txt", views: ["anchors"] } },
      { tool: "read", args: { path: "delete.txt", views: ["anchors"] } },
      {
        tool: "insert",
        reuse: reuse(0),
      },
      {
        tool: "insert",
        reuse: reuse(0),
        parallelWith: 2,
      },
      {
        tool: "insert",
        args: { path: "./insert.txt" },
        parallelWith: 3,
      },
      { tool: "delete", reuse: reuse(1), parallelWith: 4 },
      { tool: "delete", reuse: reuse(1), parallelWith: 5 },
      { tool: "delete", args: { path: "./delete.txt" }, parallelWith: 6 },
    ],
    {
      modes: ["codemode"],
      files: {
        "insert.txt": "first\nmiddle\nlast\n",
        "delete.txt": "keep\nfirst\n\nmiddle\n\nlast\n",
      },
      expected: {
        "insert.txt": "first\nFIRST\nmiddle\nMIDDLE\nlast\nLAST\n",
        "delete.txt": "keep\n\n\n",
      },
    },
  );
}
add(
  "undo-last",
  ["edit.undo-last", "compose.mutation-undo"],
  'In task.txt, use replace with at equal to "OLD" and text equal to "NEW". After Replace returns, use undo with change equal to "last" (file is optional). After Undo returns, Read the file and report its original marker. Leave the original CRLF bytes intact.',
  [
    { tool: "replace", args: { path: "task.txt", text: "NEW" } },
    { tool: "undo", args: { change: "last" }, after: [0] },
    { tool: "read", args: { path: "task.txt" }, contains: "OLD", after: [1] },
  ],
  {
    files: { "task.txt": "keep\r\nOLD\r\n" },
    expected: { "task.txt": "keep\r\nOLD\r\n" },
    answer: "OLD",
  },
);

add(
  "git-stage-unstage-undo",
  ["git.changes", "git.stage", "git.stage-noop", "git.unstage", "git.undo-change", "discovery.git"],
  "Replace OLD with NEW in task.txt. After the Replace result returns, Read changes for task.txt using either its file path or that Replace result, then stage the returned CHANGE anchor. In the direct route, discover stage and unstage using native tool_search before calling them. In Codemode, call tools.stage and tools.unstage without discovery or inspect them with describeTool; keep Replace, every Read, Stage, Unstage and Undo inside Codemode. Wait for the Stage result before repeating stage with that anchor to confirm it succeeds as already staged. After the repeated Stage result returns, Read changes again and unstage its current CHANGE anchor. After the Unstage result returns, Read changes once more and undo that current change. Leave source and index at the original clean state.",
  [
    { tool: "replace" },
    { tool: "read", args: { path: "task.txt", views: ["changes"] }, after: [0] },
    {
      tool: "stage",
      args: { file: "task.txt" },
      reuse: reuse(1, "change", "change"),
      contains: "<system-result",
    },
    {
      tool: "stage",
      args: { file: "task.txt" },
      reuse: reuse(1, "change", "change"),
      contains: "already staged",
      after: [2],
    },
    { tool: "read", args: { path: "task.txt", views: ["changes"] }, after: [3] },
    { tool: "unstage", args: { file: "task.txt" }, reuse: reuse(4, "change", "change") },
    { tool: "read", args: { path: "task.txt", views: ["changes"] }, after: [5] },
    { tool: "undo", args: { file: "task.txt" }, reuse: reuse(6, "change", "change") },
  ],
  { git: true },
);

add(
  "read-search-narrow",
  ["compose.search-narrow-result"],
  "Read only line 1 of task.txt (offset 1, limit 1). Search inside that unchanged Read result with query regex:(?<=\\[)[^\\]]+(?=\\]), passing the regex backslashes unchanged. This selects only the text between the brackets. Replace that Search selection with NEW. Keep all other bytes, including the bracketed text on line 2.",
  [
    { tool: "read", args: { path: "task.txt", offset: 1, limit: 1 } },
    { tool: "search", args: { query: /^regex:/ }, reuse: reuse(0) },
    { tool: "replace", reuse: reuse(1) },
  ],
  {
    files: { "task.txt": "keep [OLD] keep\n[KEEP]\n" },
    expected: { "task.txt": "keep [NEW] keep\n[KEEP]\n" },
  },
);

add(
  // This route starts with one prepared index; live engine switching is verified separately.
  "semantic-code-search",
  ["search.semantic", "search.semantic-scope-filters", "compose.semantic-read"],
  "Use semantic_search with the exact query expire a user session in all three calls: first path ., then path src with spaces with include *.ts and exclude *.test.ts, then path src with spaces/session.ts. Read src with spaces/session.ts and report the function name. Do not change files.",
  [
    {
      tool: "semantic_search",
      args: { query: "expire a user session" },
      contains: "src with spaces/session.ts",
    },
    {
      tool: "semantic_search",
      args: {
        query: "expire a user session",
        path: "src with spaces",
        include: "*.ts",
        exclude: "*.test.ts",
      },
      contains: "src with spaces/session.ts",
      excludes: "src with spaces/noise.test.ts",
    },
    {
      tool: "semantic_search",
      args: { query: "expire a user session", path: "src with spaces/session.ts" },
      contains: "src with spaces/session.ts:1-1",
    },
    { tool: "read", args: { path: "src with spaces/session.ts" }, contains: "expireSession" },
  ],
  {
    // Serialize cold downloads and ONNX sessions, including searches after initialization.
    resource: "colgrep",
    prerequisite: "/bin/bash /source/benchmarks/tool-capabilities/prepare-colgrep.sh",
    files: {
      "src with spaces/session.ts":
        "export function expireSession(session: { expiresAt: number }) { return Date.now() >= session.expiresAt; }\n",
      "src with spaces/noise.test.ts":
        "export function testSession() { return 'session expiry'; }\n",
    },
    answer: "expireSession",
  },
);

add(
  "semantic-code-search-vera",
  ["search.semantic-vera", "search.semantic-vera-scope-filters", "compose.semantic-vera-read"],
  "Use semantic_search with the exact query expire a user session in all three calls: first path ., then path src with spaces with include *.ts and exclude *.test.ts, then path src with spaces/session.ts. Read src with spaces/session.ts and report the function name. Do not change files.",
  [
    {
      tool: "semantic_search",
      args: { query: "expire a user session" },
      contains: "src with spaces/session.ts",
    },
    {
      tool: "semantic_search",
      args: {
        query: "expire a user session",
        path: "src with spaces",
        include: "*.ts",
        exclude: "*.test.ts",
      },
      contains: "src with spaces/session.ts",
      excludes: "src with spaces/noise.test.ts",
    },
    {
      tool: "semantic_search",
      args: { query: "expire a user session", path: "src with spaces/session.ts" },
      contains: "src with spaces/session.ts:1-1",
    },
    { tool: "read", args: { path: "src with spaces/session.ts" }, contains: "expireSession" },
  ],
  {
    prerequisite:
      'command -v vera && export VERA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/pi-agent-ide/vera" VERA_NO_UPDATE_CHECK=1 && vera setup --potion-code --yes && vera index . --json',
    setup: "semantic-vera",
    files: {
      ".pi/pi-agent-ide/extensions.json": '{"preferences":{"search.semantic.engine":"vera"}}\n',
      "src with spaces/session.ts":
        "export function expireSession(session: { expiresAt: number }) { return Date.now() >= session.expiresAt; }\n",
      "src with spaces/noise.test.ts":
        "export function testSession() { return 'session expiry'; }\n",
    },
    answer: "expireSession",
  },
);
add(
  "semantic-vera-refresh",
  ["search.semantic-vera-refresh"],
  "Write fresh.ts with exactly `export function nebulaOtterRefreshSentinel() { return 73; }` followed by a newline. Then use semantic_search with path . and query nebulaOtterRefreshSentinel to find the newly written file, without running a separate index or update command. Report the returned path.",
  [
    {
      tool: "write",
      args: {
        path: "fresh.ts",
      },
    },
    {
      tool: "semantic_search",
      after: [0],
      args: { query: "nebulaOtterRefreshSentinel" },
      contains: "fresh.ts",
    },
  ],
  {
    prerequisite:
      'command -v vera && export VERA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/pi-agent-ide/vera" VERA_NO_UPDATE_CHECK=1 && vera setup --potion-code --yes && vera index . --json',
    setup: "semantic-vera",
    files: {
      ".pi/pi-agent-ide/extensions.json": '{"preferences":{"search.semantic.engine":"vera"}}\n',
      "initial.ts": "export function existing() { return 12; }\n",
    },
    expected: { "fresh.ts": "export function nebulaOtterRefreshSentinel() { return 73; }\n" },
    answer: "fresh.ts",
  },
);
add(
  "semantic-script-files",
  ["search.semantic-script-files"],
  "Use native Codemode. Call semantic_search with path . and query expire a user session, take the first file of its ranked value, read that file in the same script and report the function name. Do not parse display text.",
  [
    {
      tool: "semantic_search",
      args: { query: "expire a user session" },
      // The value lists ranked files; ranges stay in the readable text.
      scriptResult: { 0: "src with spaces/session.ts" },
    },
    { tool: "read", args: { path: "src with spaces/session.ts" }, contains: "expireSession" },
  ],
  {
    modes: ["codemode"],
    resource: "colgrep",
    prerequisite: "/bin/bash /source/benchmarks/tool-capabilities/prepare-colgrep.sh",
    files: {
      "src with spaces/session.ts":
        "export function expireSession(session: { expiresAt: number }) { return Date.now() >= session.expiresAt; }\n",
      "src with spaces/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
    },
    answer: "expireSession",
  },
);
const syntax = { "task.ts": "function first() { return 7; }\nfunction second() { return 9; }\n" };
add(
  "outline-search-edit",
  ["outline.file", "outline.page", "compose.outline-search-edit"],
  'Call outline on task.ts with limit 1. Follow the continuation by calling outline on task.ts with offset 2 and limit 1. Search only that second outline result for "second", passing the result itself (or its id) as path. Replace only the matched name with renamed, using the Search match or its displayed match reference. Do not read the whole file or replace a declaration.',
  [
    { tool: "outline", args: { path: "task.ts", limit: 1 }, contains: "first", excludes: "second" },
    {
      tool: "outline",
      args: { path: "task.ts", offset: 2, limit: 1 },
      contains: "second",
      excludes: "first",
      after: [0],
    },
    { tool: "search", reuse: reuse(1), contains: "second" },
    { tool: "replace", reuse: reuse(2) },
  ],
  {
    files: syntax,
    expected: { "task.ts": "function first() { return 7; }\nfunction renamed() { return 9; }\n" },
  },
);
add(
  "ast-capture-rename",
  ["outline.file", "search.ast", "compose.ast-capture-edit", "compose.capture-uuid-source"],
  'Call outline with path task.ts. Call ast_search with path task.ts, language typescript and pattern "function $NAME() { return 7; }". Replace the NAME capture with renamed, passing path as {id: "<bare UUID>"}. In direct calls, take the issued NAME capture RESULT# reference and remove the RESULT# prefix. In Codemode, bind the ast_search return value to result, take const captureId = result.matches[0].captures.NAME[0].id, then pass path: {id: captureId.replace(/^RESULT#/, "")}. The id field must contain only the capture UUID, with no RESULT# prefix. Do not use the whole result, a file path or an anchor.',
  [
    { tool: "outline", args: { path: "task.ts" }, contains: "first" },
    // A pattern or a rule with a pattern can both capture NAME.
    {
      tool: "ast_search",
      issuedMatches: [{ path: "task.ts", text: "function first() { return 7; }" }],
    },
    {
      tool: "replace",
      args: {
        path: { id: /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u },
      },
      reuse: reuse(1, "path", "capture:NAME"),
    },
  ],
  {
    files: syntax,
    expected: { "task.ts": "function renamed() { return 7; }\nfunction second() { return 9; }\n" },
  },
);

add(
  "ast-search-enclosing",
  ["ast_search.rule", "compose.ast-search-enclosing"],
  'Search task.ts with query return 9. Then call ast_search with that unchanged Search result (the Search value in Codemode) as path, relation enclosing, language typescript and rule {kind: "function_declaration"}. Replace the returned whole function with text function second() { return 10; }. Keep the first function unchanged.',
  [
    { tool: "search", issuedMatches: [{ path: "task.ts", text: "return 9" }] },
    {
      tool: "ast_search",
      args: {
        relation: "enclosing",
        language: /^typescript$/i,
        rule: { kind: "function_declaration" },
      },
      reuse: reuse(0),
      issuedMatches: [{ path: "task.ts", text: "function second() { return 9; }" }],
    },
    { tool: "replace", reuse: reuse(1) },
  ],
  {
    files: syntax,
    expected: { "task.ts": "function first() { return 7; }\nfunction second() { return 10; }\n" },
  },
);

add(
  "read-ast-boundary",
  ["read.ast-view", "edit.scope-anchors"],
  "Read task.ts with the ast view. Use the returned begin/end scope anchors for the first function as from and through to replace that complete function, including its line break, with function renamed() { return 8; } followed by a line break. Keep the second function unchanged. Use ordinary file path plus scope anchors, not a result scope combined with from/through.",
  [
    { tool: "read", args: { path: "task.ts", views: ["ast"] }, contains: "scope-begin-" },
    {
      tool: "replace",
      args: {
        from: /scope-begin-/,
        through: /scope-end-/,
      },
      reuse: [reuse(0, "from", "anchor"), reuse(0, "through", "anchor")],
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
  "codemode-store",
  ["codemode.store-load", "compose.cross-call", "compose.provider-cross-call-reference"],
  "In one Codemode call, read task.txt and store the unchanged result. In a second Codemode call, load it and search within that result for OLD. Pass the resulting Search selection into replace to change OLD to NEW. Do not reread or retype the file path for the dependent operations.",
  [
    { tool: "read", args: { path: "task.txt" } },
    { tool: "search", reuse: { ...reuse(0), newParent: true } },
    { tool: "replace", reuse: reuse(1) },
  ],
  { modes: ["codemode"], expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

// Read and Search values carry their ids.
add(
  "value-id-source",
  ["compose.value-id-source"],
  "In one Codemode call, read task.txt and pass the Read value itself as Search's path to find OLD. Pass the returned Search value itself as Replace's path to change OLD to NEW. Do not pass result strings, the file path or a bare UUID to Search or Replace.",
  [
    { tool: "read", args: { path: "task.txt" } },
    { tool: "search", args: { path: { id: /^RESULT#/u } }, reuse: reuse(0) },
    { tool: "replace", args: { path: { id: /^RESULT#/u } }, reuse: reuse(1) },
  ],
  { modes: ["codemode"], expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

add(
  "replace-anchored-display",
  ["edit.replace-anchored-display"],
  'Read task.txt with views ["anchors"] and save the whole displayed second row, including its 7-character prefix and pipe but excluding the line break. Then Replace in task.txt with literal at "OLD" and text "OLD tail". After that edit finishes, try Replace in task.txt with the saved displayed row as at and text "BAD". This must refuse because its hash is stale, even though OLD still begins the line. After the refusal, Read task.txt with views ["anchors"] again. From the new second row, copy the current 7-character prefix, the pipe and OLD into Replace at; omit " tail". Pass text "NEW". Keep the suffix and every line break. Independently Read collision.txt with views ["anchors"] and Replace in collision.txt with at "|OLD" and text "NEW". That selector is both a partial display of the first row and literal source text on the second line. Only the second line should change. In Codemode, use the displayed rows in the Read value\'s text field and continue after the refused call.',
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    { tool: "replace", args: { path: "task.txt", at: "OLD" }, after: [0] },
    {
      tool: "replace",
      args: { path: "task.txt", at: /^[0-9A-HJKMNP-TV-Z]{7}\|OLD$/u },
      reuse: reuse(0, "at", "text"),
      error: true,
      after: [1],
    },
    { tool: "read", args: { path: "task.txt", views: ["anchors"] }, after: [2] },
    {
      tool: "replace",
      args: { path: "task.txt", at: /^[0-9A-HJKMNP-TV-Z]{7}\|OLD$/u },
      reuse: reuse(3, "at", "text"),
    },
    { tool: "read", args: { path: "collision.txt", views: ["anchors"] } },
    { tool: "replace", args: { path: "collision.txt", at: /^\|OLD$/u }, after: [5] },
  ],
  {
    files: { ...textFile, "collision.txt": "OLD tail\nliteral |OLD tail\n" },
    expected: {
      "task.txt": "keep\nNEW tail\nlast\n",
      "collision.txt": "OLD tail\nliteral NEW tail\n",
    },
  },
);

add(
  "ambiguous-exact-all-match",
  ["edit.ambiguous-exact-all-match"],
  'Read only line 2 of task.txt (offset 2, limit 1). Pass that bounded Read result as Replace path, with literal at "OLD", text "NEW". Wait for the ambiguous-selector refusal. In Codemode, finish the script to see its failure summary and retain the Read value for the next script. Retry Replace with the same path and text, using the SEARCH# reference ending in :all:match from that refusal as at. Change both OLD fragments on line 2 and keep line 1 unchanged. Do not rerun Search or Read to obtain a different selection.',
  [
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } },
    {
      tool: "replace",
      args: { at: "OLD", through: undefined, before: undefined },
      exactText: ["at"],
      reuse: reuse(0),
      error: true,
    },
    {
      tool: "replace",
      args: { at: /^SEARCH#[A-Fa-f\d]+:all:match$/u, through: undefined, before: undefined },
      reuse: [reuse(0), reuse(1, "at", "text")],
    },
  ],
  {
    files: { "task.txt": "outside OLD\ninside OLD and OLD\n" },
    expected: { "task.txt": "outside OLD\ninside NEW and NEW\n" },
  },
);

add(
  "copied-line-prefix-recovery",
  ["edit.copied-line-prefix-refusal"],
  "Read task.txt with anchors and wait for its result. Attempt Replace of line 2 using its issued line anchor as at and text consisting of that same 7-character anchor followed by |NEW. This deliberately copied display prefix must be refused without writes. Wait for the refusal, then retry Replace with the same at anchor and text NEW followed by a newline, without the prefix. Keep keep and last unchanged. In Codemode, continue after the refused call and keep its failure visible.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    {
      tool: "replace",
      args: { path: "task.txt", text: /^[0-9A-HJKMNP-TV-Z]{7}\|NEW$/u },
      reuse: reuse(0, "at", "anchor"),
      error: true,
      after: [0],
    },
    {
      tool: "replace",
      args: { path: "task.txt" },
      reuse: reuse(0, "at", "anchor"),
      after: [1],
    },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

add(
  "stale-line-anchor-literal-collision",
  ["edit.stale-line-anchor-literal-collision", "edit.anchor-shaped-literal-search"],
  "Read task.txt with anchors and wait for its result. Replace the OLD line with NEW followed by a newline using the issued line-2 anchor and wait for success. After that successful change, attempt both Insert BLOCKED with the old line-2 anchor as after and Replace with that same stale anchor as at and text BLOCKED. Both must fail without writes even though the anchor bytes occur literally elsewhere. The guard may intentionally stop streaming before text arrives; that is the stale refusal, not a missing-payload mistake. Do not retry an already refused call. Independently, Search task.txt for the literal D07BBXQ and pass that Search result unchanged as Replace's path with text TOKEN. The two stale checks and the Search chain need not wait for each other. The Search selection intentionally edits the literal bytes, not a line anchor. Keep every other byte. In Codemode, continue after refused calls and keep their failures visible.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    { tool: "replace", args: { path: "task.txt" }, reuse: reuse(0, "at", "anchor") },
    {
      tool: "insert",
      args: { path: "task.txt" },
      reuse: reuse(0, "after", "anchor"),
      error: true,
      after: [1],
    },
    {
      tool: "replace",
      args: { path: "task.txt" },
      reuse: reuse(0, "at", "anchor"),
      error: true,
      after: [1],
    },
    { tool: "search", args: { path: "task.txt", query: "D07BBXQ" } },
    { tool: "replace", reuse: reuse(4) },
  ],
  {
    files: { "task.txt": "keep\nOLD\nliteral D07BBXQ|payload\nlast\n" },
    expected: { "task.txt": "keep\nNEW\nliteral TOKEN|payload\nlast\n" },
  },
);

add(
  "stale-insert-recovery",
  ["edit.stale-insert-feedback", "edit.bounded-stale-feedback"],
  "Read task.txt with anchors and wait for its result to capture the original anchors. Replace OLD with NEW. Wait for the Replace result before attempting Insert with the OLD Read's line-2 anchor as after and text BLOCKED; put path and after before text in its arguments. It must fail with stale-selector feedback, not a missing-payload mistake, and must not insert BLOCKED. After that refusal returns, Read the current file and insert RECOVERED plus a newline after its fresh line-2 anchor. Keep the other bytes.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    { tool: "replace", args: { path: "task.txt" }, after: [0] },
    {
      tool: "insert",
      args: { path: "task.txt", after: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: reuse(0, "after", "anchor"),
      error: true,
      after: [1],
      finalRefusal: { guardId: "stale-anchor", effect: "not-applied" },
      // Allow retention notices above the 50 KiB useful-text budget.
      finalMaxBytes: 64 * 1024,
    },
    { tool: "read", args: { path: "task.txt", views: ["anchors"] }, after: [2] },
    {
      tool: "insert",
      args: { path: "task.txt" },
      reuse: reuse(3, "after", "anchor"),
    },
  ],
  { modes: ["direct"], expected: { "task.txt": "keep\nNEW\nRECOVERED\nlast\n" } },
);

add(
  "repeated-line-anchor-after-shift",
  ["edit.repeated-line-anchor-shift"],
  "Read task.txt with anchors and wait for its result to capture the original anchors. Insert before alpha with text top followed by a newline, which shifts every line down. Wait for the Insert result before starting Delete. Then delete the final } line of the file using its anchor from the first Read, not a new Read and not exact text. Every other line must stay.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    {
      tool: "insert",
      args: { path: "task.txt", before: /[\s\S]+/u, after: undefined },
      after: [0],
    },
    {
      tool: "delete",
      args: { path: "task.txt", at: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: reuse(0, "at", "anchor"),
      after: [1],
    },
  ],
  {
    modes: ["direct"],
    files: { "task.txt": "alpha\nfn one() {\n  work();\n}\nfn two() {\n  more();\n}\n" },
    expected: { "task.txt": "top\nalpha\nfn one() {\n  work();\n}\nfn two() {\n  more();\n" },
  },
);

add(
  "repeated-line-anchor-after-block-delete",
  ["edit.repeated-line-anchor-block-recovery"],
  "Read task.txt with anchors. Delete the first definition, from its first template line through its first } line, using anchors from that Read. Wait for that Delete result before attempting to delete the remaining template line using its anchor from the first Read; this stale anchor must be rejected. After that refusal returns, read task.txt with anchors again and delete the remaining template line using its fresh anchor. Do not use exact text. Preserve every other byte.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    {
      tool: "delete",
      args: {
        path: "task.txt",
        from: /^[0-9A-HJKMNP-TV-Z]{7}$/u,
        through: /^[0-9A-HJKMNP-TV-Z]{7}$/u,
      },
      reuse: reuse(0, ["from", "through"], "anchor"),
    },
    {
      tool: "delete",
      args: { path: "task.txt", at: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: reuse(0, "at", "anchor"),
      error: true,
      after: [1],
    },
    { tool: "read", args: { path: "task.txt", views: ["anchors"] }, after: [2] },
    {
      tool: "delete",
      args: { path: "task.txt", at: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: reuse(3, "at", "anchor"),
    },
  ],
  {
    modes: ["direct"],
    files: {
      "task.txt":
        "template <typename T>\nT one(T v) {\n  return v;\n}\ntemplate <typename T>\nT two(T v) {\n  return v;\n}\n",
    },
    expected: { "task.txt": "T two(T v) {\n  return v;\n}\n" },
  },
);

add(
  "line-anchor-range-interior-change",
  ["edit.line-anchor-range-interior-change"],
  'Read all of task.txt with views ["anchors"] and capture the 7-character anchors printed before BEGIN and END. Replace the exact line BODY OLD with BODY NEW, leaving BEGIN and END unchanged. Wait for Replace to finish, then call Delete on task.txt with from and through set to the BEGIN and END anchors from the first Read. Delete must refuse because the span changed after the anchors were issued. Leave the entire file intact after Replace.',
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    {
      tool: "replace",
      args: { path: "task.txt", at: "BODY OLD" },
      exactText: ["at"],
      after: [0],
    },
    {
      tool: "delete",
      args: {
        path: "task.txt",
        from: /^[0-9A-HJKMNP-TV-Z]{7}$/u,
        through: /^[0-9A-HJKMNP-TV-Z]{7}$/u,
      },
      reuse: reuse(0, ["from", "through"], "anchor"),
      error: true,
      after: [1],
    },
  ],
  {
    files: { "task.txt": "before\nBEGIN\nBODY OLD\nEND\nafter\n" },
    expected: { "task.txt": "before\nBEGIN\nBODY NEW\nEND\nafter\n" },
  },
);
add(
  "read-fragment-recovery",
  ["read.fragment-recovery"],
  "Read task.txt#alpha. The fragment matches twice, so Read must refuse. Use the anchored Read call printed in the refusal to read from the first candidate. For Codemode, finish the first script to see its failed Read, then make the retry in a new script. Do not edit the file.",
  [
    { tool: "read", args: { path: "task.txt#alpha" }, error: true, contains: "|alpha first" },
    {
      tool: "read",
      args: { path: /(?:^|[\\/])task\.txt#[0-9A-HJKMNP-TV-Z]{7}$/u, views: ["anchors"] },
      contains: "|alpha first",
      after: [0],
    },
  ],
  {
    files: { "task.txt": "header\nalpha first\nseparator\nalpha second\n" },
    expected: { "task.txt": "header\nalpha first\nseparator\nalpha second\n" },
  },
);
add(
  "codemode-overlap-recovery",
  ["edit.batch-overlap-recovery"],
  "In one native Codemode script, await Replace of the literal OLD with NEW in task.txt, then await Move of the literal tail onto literal OLD in the same file, using targetAt. Put no other tool calls between them. The Replace must commit; the Move must refuse on the overlapping text. Finish the script to see the refusal. Use its Read call in a new script and print the result. Do not edit again.",
  [
    { tool: "replace", args: { path: "task.txt", at: "OLD", text: "NEW" } },
    {
      tool: "move",
      args: { path: "task.txt", at: "tail", targetAt: "OLD" },
      error: true,
      parentContains: "|OLD",
      sameAssistantWith: 0,
    },
    {
      tool: "read",
      args: { path: /(?:^|[\\/])task\.txt$/u, views: ["anchors"] },
      contains: "|NEW",
      after: [1],
    },
  ],
  {
    modes: ["codemode"],
    files: { "task.txt": "OLD\nkeep\ntail\n" },
    expected: { "task.txt": "NEW\nkeep\ntail\n" },
  },
);

const wideRangeFixture = `BEGIN\n${Array.from({ length: 500 }, (_, index) => `body ${index}\n`).join("")}END\nkeep\n`;
add(
  "unseen-edit-span",
  ["edit.unseen-edit-span"],
  "Read only line 1 and line 502 of task.txt in separate calls. Then call Replace on task.txt with literal from BEGIN, literal through END, and text NEW. It must refuse because only the endpoints were read. After the refusal, use the Read call it offers, then retry the same Replace. In Codemode, finish the first script to inspect the refusal before reading the selected span. The file should contain NEW and keep, each on its own line.",
  [
    { tool: "read", args: { path: "task.txt", offset: 1, limit: 1 } },
    { tool: "read", args: { path: "task.txt", offset: 502, limit: 1 } },
    {
      tool: "replace",
      args: { path: "task.txt", from: "BEGIN", through: "END" },
      exactText: ["from", "through"],
      error: true,
      after: [0, 1],
    },
    {
      tool: "read",
      args: { path: /(?:^|[\\/])task\.txt$/u, offset: 1, limit: 502, views: ["anchors"] },
      after: [2],
    },
    {
      tool: "replace",
      args: { path: "task.txt", from: "BEGIN", through: "END" },
      exactText: ["from", "through"],
      after: [3],
    },
  ],
  { files: { "task.txt": wideRangeFixture }, expected: { "task.txt": "NEW\nkeep\n" } },
);
const oversizedRangePadding = `${"x".repeat(4095)}\n`.repeat(17 * 256);
const pagedRangeReplace = { path: "task.txt", from: "BEGIN", through: "END", text: "NEW" };
add(
  "oversized-paged-edit-span",
  ["edit.unseen-edit-span", "compose.oversized-paged-edit"],
  "Replace only lines 1 through 502 of task.txt, leaving its large suffix intact. First read just lines 1 and 502 in separate calls, then call Replace with literal from BEGIN, literal through END, and text NEW. It must refuse. After the refusal, read the selected span in two pages: offset 1 with limit 251, then offset 252 with limit 251. Wait for both pages before retrying that same Replace. In Codemode, finish the first script to see the refusal before reading either page. Preserve every byte after END.",
  [
    { tool: "read", args: { path: "task.txt", offset: 1, limit: 1 }, contains: "BEGIN" },
    { tool: "read", args: { path: "task.txt", offset: 502, limit: 1 }, contains: "END" },
    {
      tool: "replace",
      args: pagedRangeReplace,
      exactText: ["from", "through"],
      error: true,
      after: [0, 1],
    },
    {
      tool: "read",
      args: { path: "task.txt", offset: 1, limit: 251 },
      contains: "body 249",
      after: [2],
    },
    {
      tool: "read",
      args: { path: "task.txt", offset: 252, limit: 251 },
      contains: "END",
      after: [3],
    },
    {
      tool: "replace",
      args: pagedRangeReplace,
      exactText: ["from", "through"],
      after: [4],
    },
  ],
  {
    files: { "task.txt": wideRangeFixture + oversizedRangePadding },
    expected: { "task.txt": "NEW\nkeep\n" + oversizedRangePadding },
  },
);
add(
  "result-selector-scope",
  ["compose.result-selector-scope"],
  "Read task.txt with anchors; each line is shown after its 7-character anchor and a |. Then read only line 2 of task.txt. Pass that line-2 Read result unchanged as Replace's path together with the anchor the first Read shows before line 3 as at and text BAD: the anchor lies outside the result's selection, so the call must fail and show the anchor for the selected line. Wait for that refusal before passing the same line-2 result as path with the anchor the first Read shows before line 2 as at and text NEW followed by a newline. Changing line 2 before the refusal would make the bounded result stale and hide the scope check. Preserve all other bytes.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    // The window may also come from the first Read's result of the same file.
    { tool: "read", args: { offset: 2, limit: 1 } },
    {
      tool: "replace",
      args: { at: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: [reuse(1), reuse(0, "at", "anchor")],
      error: true,
      contains: "D07BBXQ", // The unchanged OLD line in the default fixture.
      excludes: "ENOENT",
    },
    {
      tool: "replace",
      args: { at: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      after: [2],
      reuse: [reuse(1), reuse(0, "at", "anchor")],
    },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" } },
);

for (const { suffix, joiner } of [
  { suffix: "plain", joiner: "" },
  { suffix: "unicode", joiner: "\u200b" },
]) {
  const old = `legacy${joiner}Checkout`;
  const replacement = `stable${joiner}Checkout`;
  const original = `header\n${Array.from(
    { length: 10 },
    (_, index) => `    route-${index + 1} = ${old};\n${index === 4 ? "unselected-gap\n" : ""}`,
  ).join("")}footer\n`;
  const wholeResult = /^(?:RESULT#)?[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u;
  add(
    `result-selector-multi-range-${suffix}`,
    ["compose.result-selector-scope"],
    `Search task.txt for the exact literal ${JSON.stringify(old)} with limit 20 and retain its complete ten-match result. Use that whole Search result unchanged as path in every Replace below. On the direct route pass an object containing the Search result's envelope UUID as id, not a numbered SEARCH reference. In Codemode pass the unchanged returned Search value as path. First try to Replace a span from the first exact match to the tenth exact match with text BAD. Pass the actual issued :1:match and :10:match references as from and through directly, or the first and tenth match values in Codemode. The span crosses unselected text, so it must refuse without writing. Next try Replace with the same path, literal at unselected-gap and text BAD; it must also refuse. After both refusals, replace all ten exact matches in one Replace with text ${JSON.stringify(replacement)}. For that final at use the original Search's :all:match reference directly, or the whole unchanged Search value in Codemode. Preserve the gap, line prefixes, punctuation and every other byte. Do not rewrite whole lines, refresh the Search or use a file path for the edits.`,
    [
      { tool: "search", args: { path: "task.txt", query: old, limit: 20 } },
      {
        tool: "replace",
        args: { path: wholeResult, from: matchReference(1), through: matchReference(10) },
        reuse: reuse(0, ["path", "from", "through"]),
        error: true,
      },
      {
        tool: "replace",
        args: { path: wholeResult, at: "unselected-gap" },
        reuse: reuse(0),
        exactText: ["at"],
        after: [1],
        error: true,
      },
      {
        tool: "replace",
        args: {
          path: wholeResult,
          at: /^(?:SEARCH#[A-F\d]+:all:match|RESULT#[a-f\d-]{36})$/u,
          through: undefined,
          before: undefined,
        },
        reuse: reuse(0, ["path", "at"]),
        after: [2],
      },
    ],
    {
      files: { "task.txt": original },
      expected: { "task.txt": original.replaceAll(old, replacement) },
    },
  );
}

add(
  "result-selector-surviving-scope",
  ["compose.result-selector-scope"],
  "Read task.txt with anchors and keep the original anchors for lines 1, 3, 4 and 6. Read all of task.txt again and keep that second Read result unchanged as the scope for every Delete below. First delete the first template function: pass the second Read result as path with the original line-1 anchor as from and original line-4 anchor as through. After that succeeds, separately try Delete with that same scope and the original line-1 anchor, then with the original line-3 anchor: both must refuse without editing, since those lines belonged to the deleted copy. Finally delete only the surviving declaration T two(T v) {, using the same unchanged second Read result as path and the original line-6 anchor as at. Do not read again, refresh the scope, use literal selectors, or rewrite the file. Keep the surviving template line, return line and closing brace byte for byte.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    { tool: "read", args: { path: "task.txt" }, after: [0] },
    {
      tool: "delete",
      args: { from: /^[0-9A-HJKMNP-TV-Z]{7}$/u, through: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: [reuse(1), reuse(0, ["from", "through"], "anchor")],
    },
    {
      tool: "delete",
      args: { at: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: [reuse(1), reuse(0, "at", "anchor")],
      after: [2],
      error: true,
    },
    {
      tool: "delete",
      args: { at: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: [reuse(1), reuse(0, "at", "anchor")],
      after: [3],
      error: true,
    },
    {
      tool: "delete",
      args: { at: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
      reuse: [reuse(1), reuse(0, "at", "anchor")],
      after: [4],
    },
  ],
  {
    files: {
      "task.txt":
        "template <typename T>\nT one(T v) {\n  return v;\n}\ntemplate <typename T>\nT two(T v) {\n  return v;\n}\n",
    },
    expected: { "task.txt": "template <typename T>\n  return v;\n}\n" },
  },
);

add(
  "result-selector-exact-retry",
  ["compose.result-selector-scope"],
  "Read only line 2 of task.txt. Pass that Read result unchanged as Replace's path with at last and text BAD. The text exists outside the selection, so the call must fail without editing. Then pass the explicit task.txt path to Replace with at last and text fixed. This exact-text edit must succeed without an intervening anchor edit. Preserve all other bytes.",
  [
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } },
    {
      tool: "replace",
      args: { at: "last" },
      reuse: reuse(0),
      error: true,
    },
    { tool: "replace", args: { path: "task.txt", at: "last" } },
  ],
  { expected: { "task.txt": "keep\nOLD\nfixed\n" } },
);

add(
  "stale-recovery",
  ["compose.stale-recovery", "read.reference-recovery"],
  "Read task.txt with anchors and wait for its result to capture OLD. Change OLD to NEW using replace. After the Replace result returns, try to read the old Read result; it must be rejected as stale. Also read the current file after the replacement and report NEW; this is independent of the rejected old-result Read. Do not try to revive the old result.",
  [
    { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
    { tool: "replace", after: [0] },
    { tool: "read", error: true, reuse: reuse(0), after: [1] },
    { tool: "read", args: { path: "task.txt" }, contains: "NEW", after: [1] },
  ],
  { expected: { "task.txt": "keep\nNEW\nlast\n" }, answer: "NEW" },
);

add(
  // The first Bash call activates terminal guidance before shared-tool follow-up operations.
  // Schema publication and owner delivery are checked without inference in integration tests.
  "shell-roundtrip",
  [
    "shell.execute",
    "shell.read",
    "shell.search",
    "shell.input",
    "compose.shell-first-use-input",
    "compose.shell-input-read",
    "compose.shell-keys-read",
    "shell.keys",
    "compose.shell-reference-after-input",
    "shell.file-authority-refusal",
    "shell.delete",
  ],
  'Start Bash with command IFS= read -r line; printf \'%s\\nSHELL-FINAL-LINE\\n\' "$line" and background true; it waits for one input line, prints that line and then SHELL-FINAL-LINE before exiting. Wait for that first Bash result before choosing the shared-tool follow-up arguments from the available terminal guidance. Use its returned shell resource: write the text hello without Enter and wait for the Write result before inserting the Enter key. Wait for the Insert result before reading the unchanged Write and Insert results to inspect that same shell. In Codemode, Write and Insert to a shell resolve to null because they select no text; skip those two Reads. Also read the completed shell using its original resource and check that it includes SHELL-FINAL-LINE. The direct route may read all three sources together in one Read path array; preserve each actual result reference. Next attempt to replace hello with BAD through that terminal Read result and confirm the no-reusable-text-selection refusal: terminal output grants no file-edit authority. The streaming guard may refuse after path/at, before the text payload arrives; that early refusal is valid. After the refusal, search the shell\'s retained output with query "hello", and wait for the Search result before deleting the shell session. Report the echoed input line, hello. Do not edit files.',
  [
    { tool: "bash", args: { background: true } },
    { tool: "write", args: { content: "hello" }, reuse: reuse(0, "path", "shell") },
    { tool: "insert", args: { text: "Enter" }, reuse: reuse(0, "path", "shell"), after: [1] },
    // A Codemode script gets null for terminal input, so only a direct route can read its result.
    { tool: "read", reuse: reuse(1), contains: "hello", modes: ["direct"] },
    { tool: "read", reuse: reuse(2), contains: "hello", modes: ["direct"] },
    { tool: "read", reuse: reuse(0, "path", "shell"), contains: "SHELL-FINAL-LINE", after: [2] },
    {
      tool: "replace",
      // Authority checks may refuse before either the selector or the payload arrives.
      reuse: reuse(5),
      error: true,
      contains: "no reusable text selection",
    },
    {
      tool: "search",
      args: { query: "hello" },
      after: [6],
      reuse: reuse(0, "path", "shell"),
      contains: "hello",
    },
    { tool: "delete", reuse: reuse(0, "path", "shell"), after: [7] },
  ],
  { expected: textFile, answer: "hello" },
);

add(
  "shell-screen",
  ["shell.image", "shell.sequence"],
  'Run Bash with command printf SCREEN-MARKER and background false. Read its returned shell resource with views ["image"], then with views ["sequence:duration=1,interval=0.25"]. The sequence must contain at least two frames. Report the printed marker. Do not edit files.',
  [
    { tool: "bash", args: { command: /SCREEN-MARKER/ } },
    {
      tool: "read",
      args: { views: ["image"] },
      reuse: reuse(0, "path", "shell"),
      image: true,
      scriptResult: { type: "image", mimeType: "image/png" },
    },
    {
      tool: "read",
      args: { views: [/^sequence(?::|$)/] },
      reuse: reuse(0, "path", "shell"),
      image: 2,
      scriptResult: { type: "images" },
    },
  ],
  { answer: "SCREEN-MARKER" },
);

add(
  "shell-catalog",
  ["shell.name", "shell.list", "shell.search-all", "shell.rename"],
  "Run Bash with command printf CATALOG-ONE; sleep 30, name catalog-worker and background true. Then run Bash with command printf CATALOG-TWO, background false and no name. Read the list of your terminal sessions, then search all of them at once for CATALOG. Rename catalog-worker to catalog-renamed, read the renamed session at its new address, and delete it. Report the marker the renamed session printed. Do not edit files.",
  [
    { tool: "bash", args: { name: "catalog-worker", background: true } },
    { tool: "bash", args: { command: /CATALOG-TWO/ } },
    { tool: "read", args: { path: "shell:" }, contains: "shell:catalog-worker" },
    { tool: "search", args: { path: "shell:", query: /CATALOG/ }, contains: "CATALOG-TWO" },
    { tool: "move", args: { path: "shell:catalog-worker", target: "shell:catalog-renamed" } },
    { tool: "read", args: { path: "shell:catalog-renamed" }, contains: "CATALOG-ONE" },
    { tool: "delete", args: { path: "shell:catalog-renamed" } },
  ],
  { expected: textFile, answer: "CATALOG-ONE" },
);

add(
  "shell-script-value",
  ["shell.script-value"],
  "Use native Codemode. Run the Bash command printf partial; exit 3 and take its exit code and output from the returned object, not from display text. A non-zero exit code is a value, not a failure; do not catch errors. Then run Bash with command printf READY; sleep 30 and background true, and delete its session using the session field of its returned object. Report the exit code and output of the first command. Do not edit files.",
  [
    {
      tool: "bash",
      args: { command: /exit 3/ },
      // A direct call still reports the non-zero exit as an error.
      error: true,
      scriptResult: { exit_code: 3, output: /partial/, truncated: false },
    },
    { tool: "bash", args: { background: true }, scriptResult: { session: /^shell:/ } },
    { tool: "delete", reuse: reuse(1, "path", "shell") },
  ],
  { modes: ["codemode"], expected: textFile, answer: "partial" },
);

add(
  "debug-roundtrip",
  [
    "debug.create",
    "compose.debug-first-use-controls",
    "debug.read",
    "debug.breakpoints",
    "debug.start",
    "debug.evaluate",
    "debug.delete",
    "discovery.debug",
  ],
  "In the direct route discover debug with native tool_search; in Codemode, tools.debug is callable without discovery. Call debug with adapter debugpy and program task.py. In the Codemode route, keep every follow-up Read, Insert and Delete inside Codemode. Discovery alone does not activate shared-tool guidance; wait for the debug call to finish before choosing the follow-up arguments. First read the session using the returned debugger resource. Then use the available debugger guidance to read its source with anchors, place a breakpoint on the print line using insert breakpoint, and wait for the breakpoint Insert result before starting the debugger. After the Start result returns, evaluate value with insert evaluate value and Read the stopped session; these two calls are independent. Wait for the evaluation and both session Read results before deleting the debugger session. Report value in plain digits. Source must stay unchanged.",
  [
    { tool: "debug", args: { adapter: "debugpy", program: "task.py" } },
    { tool: "read", reuse: reuse(0, "path", "debug") },
    { tool: "read", args: { path: /debug:.*\/source/, views: ["anchors"] }, after: [0] },
    {
      tool: "insert",
      args: { path: /debug:.*\/source/, text: "breakpoint" },
      reuse: reuse(2, "after", "anchor"),
    },
    { tool: "insert", args: { text: "start" }, reuse: reuse(0, "path", "debug"), after: [3] },
    {
      tool: "insert",
      args: { text: "evaluate value" },
      after: [4],
      reuse: reuse(0, "path", "debug"),
      contains: "42",
    },
    { tool: "read", reuse: reuse(0, "path", "debug"), after: [4] },
    { tool: "delete", reuse: reuse(0, "path", "debug"), after: [1, 5, 6] },
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
    "compose.debug-breakpoint-delete-read-session",
    "read.breakpoints",
  ],
  'In the direct route discover debug with native tool_search; in Codemode, tools.debug is callable without discovery. Create a session with adapter debugpy and program task.py. Wait for the debug result before choosing shared-tool arguments from the available debugger guidance. Read its source with anchors and place a breakpoint on the answer assignment. After the breakpoint Insert result returns, do two independent operations: Read with path equal to the returned source resource (ending in /source, not the session resource) and views ["breakpoints"] to inspect the annotated source code; Start the debugger session. After the Start result returns, Read the stopped session and wait for that Read result before stepping into the twice function. After Step Into returns, Read the stopped session and wait for that Read result before stepping over its first assignment. After Step Over returns, Read the stopped session and evaluate result; these two calls are independent. Wait for both results before stepping out. After Step Out returns, Read the stopped session. Independently, delete the returned breakpoint resource after both Step Out and the breakpoints-view Read return. After the breakpoint Delete result returns, Read the session to confirm it is still stopped. Wait for both post-Step-Out session Reads before continuing to completion. After Continue returns, Read the completed session. Wait for that Read result before deleting the session. Report the evaluated result in plain digits. Do not change source files.',
  [
    { tool: "debug", args: { adapter: "debugpy", program: "task.py" } },
    { tool: "read", args: { path: /debug:.*\/source/, views: ["anchors"] }, after: [0] },
    {
      tool: "insert",
      args: { path: /debug:.*\/source/, text: "breakpoint" },
      reuse: reuse(1, "after", "anchor"),
    },
    {
      tool: "read",
      args: { path: /debug:.*\/source/, views: ["breakpoints"] },
      contains: "twice",
      after: [2],
    },
    { tool: "insert", args: { text: "start" }, reuse: reuse(0, "path", "debug"), after: [2] },
    { tool: "read", reuse: reuse(0, "path", "debug"), after: [4] },
    {
      tool: "insert",
      args: { text: "step into" },
      reuse: reuse(0, "path", "debug"),
      after: [5],
    },
    { tool: "read", reuse: reuse(0, "path", "debug"), after: [6] },
    {
      tool: "insert",
      args: { text: "step over" },
      reuse: reuse(0, "path", "debug"),
      after: [7],
    },
    { tool: "read", reuse: reuse(0, "path", "debug"), after: [8] },
    {
      tool: "insert",
      args: { text: "evaluate result" },
      reuse: reuse(0, "path", "debug"),
      contains: "42",
      after: [8],
    },
    {
      tool: "insert",
      args: { text: "step out" },
      reuse: reuse(0, "path", "debug"),
      after: [9, 10],
    },
    { tool: "read", reuse: reuse(0, "path", "debug"), after: [11] },
    { tool: "delete", reuse: reuse(2, "path", "breakpoint"), after: [3, 11] },
    {
      tool: "read",
      reuse: reuse(0, "path", "debug"),
      contains: "Status: stopped",
      after: [13],
    },
    {
      tool: "insert",
      args: { text: "continue" },
      reuse: reuse(0, "path", "debug"),
      after: [12, 14],
    },
    { tool: "read", reuse: reuse(0, "path", "debug"), after: [15] },
    { tool: "delete", reuse: reuse(0, "path", "debug"), after: [16] },
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
  "debug-backend-fallback",
  ["debug.backend-vscode-refusal", "debug.backend-native"],
  "In the direct route discover debug with native tool_search; in Codemode, tools.debug is callable without discovery. Call debug with adapter debugpy, program task.py and backend vscode. For the Codemode route, make both tools.debug attempts and every follow-up Read, Insert and Delete inside Codemode. When it reports that VS Code is unavailable, create a debugpy session with backend native instead. Wait for that debug result before choosing shared-tool arguments from the available debugger guidance. Read its source with anchors, place a breakpoint on the print line and wait for its Insert result before starting. After Start returns, evaluate value while stopped. Wait for the evaluation result before deleting the session. Report value in plain digits. Do not change source files.",
  [
    {
      tool: "debug",
      args: { backend: "vscode", program: "task.py" },
      error: true,
      contains: "VS Code",
    },
    {
      tool: "debug",
      args: { backend: "native", adapter: "debugpy", program: "task.py" },
      after: [0],
    },
    { tool: "read", args: { path: /debug:.*\/source/, views: ["anchors"] }, after: [1] },
    {
      tool: "insert",
      args: { path: /debug:.*\/source/, text: "breakpoint" },
      reuse: reuse(2, "after", "anchor"),
    },
    { tool: "insert", args: { text: "start" }, reuse: reuse(1, "path", "debug"), after: [3] },
    {
      tool: "insert",
      args: { text: "evaluate value" },
      after: [4],
      reuse: reuse(1, "path", "debug"),
      contains: "42",
    },
    { tool: "delete", reuse: reuse(1, "path", "debug"), after: [5] },
  ],
  {
    files: { "task.py": "value = 42\nprint(value)\n" },
    answer: "42",
    prerequisite: "python3 -c 'import debugpy'",
  },
);

add(
  "diagnostics-report",
  ["diagnostics.file", "compose.diagnostics-read-search", "diagnostics.readonly-report"],
  "Call diagnostics for problem.ts. Reuse that exact report as path in Read, then reuse the original report as path in Search with query 2322. Attempt Replace with the original report as path, at broken and text changed; it must refuse, not edit the source. Report diagnostic code 2322 in plain digits. Do not change any files. In Codemode check the diagnostics value has text and id, and reuse that value unchanged.",
  [
    {
      tool: "diagnostics",
      args: { path: "problem.ts" },
      contains: "typescript-language-server:2322",
    },
    { tool: "read", reuse: reuse(0), contains: "typescript-language-server:2322" },
    { tool: "search", args: { query: "2322" }, reuse: reuse(0), contains: "2322" },
    { tool: "replace", reuse: reuse(0), error: true },
  ],
  {
    files: {
      "problem.ts": 'export function broken(): number {\n  return "diagnostic";\n}\n',
      "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true},"include":["*.ts"]}\n',
      ".pi/pi-agent-ide/extensions.json": '{"flags":{"pi-agent-ide-no-diagnostic-buffer":true}}\n',
    },
    expected: { "problem.ts": 'export function broken(): number {\n  return "diagnostic";\n}\n' },
    answer: "2322",
    prerequisite: "command -v typescript-language-server",
  },
);
add(
  "rust-diagnostics-no-build",
  ["read.rust-diagnostics-no-build"],
  "Read src/main.rs with the diagnostics view, then use lsp_search with declaration src/main.rs#main to confirm the Rust server is running. Call diagnostics with path src/main.rs. Keep the source and tool configuration unchanged. Do not run Cargo or enable build-backed diagnostics. Report the main function name; an incomplete native diagnostic snapshot is acceptable.",
  [
    { tool: "read", args: { path: "src/main.rs", views: ["diagnostics"] } },
    { tool: "lsp_search", args: { declaration: "src/main.rs#main" }, contains: "main" },
    { tool: "diagnostics", args: { path: "src/main.rs" } },
  ],
  {
    files: {
      "Cargo.toml":
        '[package]\nname = "rust-diagnostic-capability"\nversion = "0.1.0"\nedition = "2021"\n',
      // Cargo metadata creates this during server startup even when compilation is disabled.
      "Cargo.lock":
        '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 3\n\n[[package]]\nname = "rust-diagnostic-capability"\nversion = "0.1.0"\n',
      "src/main.rs": "fn main() {}\n",
      // No dependencies: an accidental build stays small and records its side effect.
      "build.rs":
        'fn main() { std::fs::write("build-attempted", "unexpected").unwrap(); panic!("unexpected diagnostic build"); }\n',
    },
    expected: { "src/main.rs": "fn main() {}\n", "build-attempted": null },
    forbiddenTools: ["bash", "write", "replace", "insert", "delete"],
    prerequisite: "rust-analyzer --version && cargo clippy --version",
  },
);

add(
  "lsp-read",
  ["lsp.symbols", "lsp.references", "lsp.graph", "lsp.diagnostics", "read.diagnostics-view"],
  "Use lsp_search with query count on task.ts, then lsp_search again with that returned result as path and references true to find its usage. Use lsp_search with declaration task.ts#count, then with calls task.ts#count. Call diagnostics with path problem.ts and also read problem.ts with the diagnostics view; wait for the actual TypeScript error report, not a pending/unavailable status. Report the declared count value and diagnostic code in plain digits. Do not change files.",
  [
    {
      tool: "lsp_search",
      args: { path: "task.ts", query: "count" },
      contains: "count",
    },
    {
      tool: "lsp_search",
      args: { query: "count", references: true },
      reuse: reuse(0),
      contains: "count",
    },
    { tool: "lsp_search", args: { declaration: /^task\.ts#.*count$/ }, contains: "3" },
    { tool: "lsp_search", args: { calls: /^task\.ts(?:#.*)?$/ }, contains: "References" },
    {
      tool: "diagnostics",
      args: { path: "problem.ts" },
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
  [
    "lsp.rename",
    "lsp.rename-cross-file",
    "lsp.rename-keeps-unrelated-names",
    "lsp.rename-refusal-recovery",
    "lsp.rename-selector-refusal",
    "compose.symbol-read-rename",
    "compose.capture-uuid-source",
  ],
  'Use lsp_search with declaration task.ts#count. Try replacing its name capture with empty text; this must fail without changes. For this first replacement, pass path as {id: "<bare UUID>"}. In direct calls, take the issued name capture RESULT# reference and remove the RESULT# prefix. In Codemode, bind the lsp_search return value to result, take const captureId = result.matches[0].captures.name[0].id, then pass path: {id: captureId.replace(/^RESULT#/, "")}. The id field must contain only the capture UUID, with no RESULT# prefix. Wait for that refusal result, then try replacing the same name capture with at: "count" and text: "total"; this mixed semantic-name/literal-selector request must also fail without changes. Wait for its refusal before replacing the same issued name capture with total to rename through LSP, using its original prefixed reference or capture value. The declaration, same-file usage, and import and usage in usage.ts must change. Keep the string and unrelated local count unchanged. Do not do an ordinary text replacement.',
  [
    { tool: "lsp_search", args: { declaration: /^task\.ts#.*count$/ }, contains: "count" },
    {
      tool: "replace",
      args: {
        path: { id: /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u },
        text: "",
      },
      contains: "INVALID_REQUEST",
      excludes: "PLUGIN_FAILED",
      reuse: reuse(0, "path", "capture:name"),
      after: [0],
      error: true,
    },
    {
      tool: "replace",
      args: { at: "count", text: "total" },
      reuse: reuse(0, "path", "capture:name"),
      after: [1],
      error: true,
      contains: "INVALID_REQUEST",
      excludes: "PLUGIN_FAILED",
    },
    {
      tool: "replace",
      args: {
        text: "total",
        at: undefined,
        from: undefined,
        after: undefined,
        through: undefined,
        before: undefined,
      },
      reuse: reuse(0, "path", "capture:name"),
      after: [2],
    },
  ],
  {
    files: {
      "task.ts":
        'export const count = 3;\nexport const doubled = count * 2;\nexport const label = "count";\n',
      "usage.ts":
        'import { count } from "./task";\nexport const answer = count;\nexport function unrelated() { const count = 7; return count; }\n',
      "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
    },
    expected: {
      "task.ts":
        'export const total = 3;\nexport const doubled = total * 2;\nexport const label = "count";\n',
      "usage.ts":
        'import { total } from "./task";\nexport const answer = total;\nexport function unrelated() { const count = 7; return count; }\n',
    },
    prerequisite: "command -v typescript-language-server",
  },
);

// Quiet workspace. Real-Pi lsp-rename-window tests cover retries after a peer changes the file.
add(
  "lsp-overload-rename",
  ["lsp.overload-selectors", "compose.symbol-overload-rename"],
  'In main.cpp, ask lsp_search for the declaration main.cpp#clamp. It has several overloads; take the selector of the overload whose first parameter is a const Vec& from the result, and get that exact declaration, then rename it to clampVec by replacing its issued name capture using path: {id: "<bare UUID>"}. In direct calls remove RESULT# from the displayed name capture reference. In Codemode bind the exact declaration result to result, then pass path: {id: result.matches[0].captures.name[0].id.replace(/^RESULT#/, "")}. The id must contain only the UUID. Both prototypes, the definition and both calls with a Vec must change; the int overload and its calls stay unchanged. Do not do an ordinary text replacement.',
  [
    {
      tool: "lsp_search",
      args: { declaration: "main.cpp#clamp" },
      error: true,
      contains: "main.cpp#clamp(const Vec&, float, float)",
    },
    {
      tool: "lsp_search",
      args: { declaration: /^main\.cpp#clamp\(const Vec ?&, ?float, ?float\)$/ },
      contains: "return {static_cast<float>(clamp(static_cast<int>(v.x), 0, 1)), v.y};",
      after: [0],
    },
    {
      tool: "replace",
      args: { path: { id: /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u } },
      after: [1],
      reuse: reuse(1, "path", "capture:name"),
    },
  ],
  {
    files: {
      "main.cpp":
        "struct Vec { float x, y; };\ninline int clamp(int v, int lo, int hi);\ninline Vec clamp(const Vec& v, float lo, float hi);\ninline Vec clamp(const Vec& point, float lower, float upper);\n\ninline int clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }\ninline Vec clamp(const Vec& v, float lo, float hi) {\n  return {static_cast<float>(clamp(static_cast<int>(v.x), 0, 1)), v.y};\n}\n\nint main() {\n  Vec v = clamp(clamp(Vec{1, 2}, 0.0f, 1.0f), 0.0f, static_cast<float>(clamp(3, 0, 2)));\n  return clamp(3, 0, 2) + static_cast<int>(v.x);\n}\n",
      "compile_flags.txt": "-std=c++17\n",
    },
    expected: {
      "main.cpp":
        "struct Vec { float x, y; };\ninline int clamp(int v, int lo, int hi);\ninline Vec clampVec(const Vec& v, float lo, float hi);\ninline Vec clampVec(const Vec& point, float lower, float upper);\n\ninline int clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }\ninline Vec clampVec(const Vec& v, float lo, float hi) {\n  return {static_cast<float>(clamp(static_cast<int>(v.x), 0, 1)), v.y};\n}\n\nint main() {\n  Vec v = clampVec(clampVec(Vec{1, 2}, 0.0f, 1.0f), 0.0f, static_cast<float>(clamp(3, 0, 2)));\n  return clamp(3, 0, 2) + static_cast<int>(v.x);\n}\n",
    },
    prerequisite: "command -v clangd",
  },
);

const callGraphSource = [
  "export function validate(value: number): boolean {",
  "  return value > 0;",
  "}",
  "",
  "export function save(value: number): boolean {",
  "  return validate(value);",
  "}",
  "",
  "export function submit(): boolean {",
  "  return save(1);",
  "}",
  "",
  "export function retry(): boolean {",
  "  return save(2);",
  "}",
  "",
].join("\n");
add(
  "lsp-calls-script-value",
  ["lsp.script-call-graph", "compose.lsp-caller-id", "lsp.script-line-text"],
  "In one Codemode call, use lsp_search with calls task.ts#save. Its value lists callers in incoming and callees in outgoing, each as its whole declaration. Check that the callers are submit and retry and the callee is validate. Then delete the caller retry by passing its incoming entry or that entry's id to delete, not a symbol or file path. Report the number of callers in plain digits.",
  [
    {
      tool: "lsp_search",
      args: { calls: "task.ts#save" },
      scriptResult: {
        complete: true,
        incoming: { length: 2 },
        outgoing: {
          length: 1,
          0: {
            path: "task.ts",
            line: 1,
            lineText: "export function validate(value: number): boolean {\n  return value > 0;\n}",
          },
        },
      },
    },
    { tool: "delete", args: { path: /^RESULT#[a-f\d-]{36}$/u }, reuse: reuse(0) },
  ],
  {
    modes: ["codemode"],
    files: {
      "task.ts": callGraphSource,
      "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n',
    },
    expected: { "task.ts": callGraphSource.replace(/export function retry[^}]*\}\n/u, "") },
    answer: "2",
    prerequisite: "command -v typescript-language-server",
  },
);

add(
  "read-media",
  ["read.image", "read.pdf"],
  "Use read to inspect sample.png, sample.pdf and recovered.pdf. Report the text marker inside the PDFs. Do not change files.",
  [
    { tool: "read", args: { path: "sample.png" }, image: true },
    { tool: "read", args: { path: "sample.pdf" }, contains: "PDF-MARKER" },
    { tool: "read", args: { path: "recovered.pdf" }, contains: "PDF-MARKER" },
  ],
  { files: {}, answer: "PDF-MARKER", setup: "media" },
);

add(
  "codemode-image-value",
  ["compose.codemode-image-value"],
  "In one Codemode call, read sample.png and show the returned image block with image(). Report its mimeType. Do not change files.",
  [
    {
      tool: "read",
      args: { path: "sample.png" },
      scriptResult: { type: "image", mimeType: "image/png" },
    },
  ],
  { modes: ["codemode"], files: {}, answer: "image/png", setup: "media" },
);

add(
  "read-image-write",
  ["compose.read-image-write"],
  "Read pixel.png, then save the image that Read returned to copy.png with Write: pass that Read result as Write image (its UUID in a direct call, the returned image value in Codemode). Do not use Copy and do not change other files. Report the written path.",
  [
    { tool: "read", args: { path: "pixel.png" }, image: true },
    { tool: "write", args: { path: "copy.png" }, reuse: reuse(0, "image") },
  ],
  { files: {}, setup: "pixel", expected: { "copy.png": pixelPng } },
);

const jsonText =
  '{"name": "demo", "ratio": 1.0, "tags": ["a", "b"], "quote": "say \\"hi\\"", "none": null}\n';
add(
  "write-json-text",
  ["write.json-text"],
  `Use Write to create data.json with exactly this JSON text, byte for byte, ending with one newline. Keep the spacing, the key order and the number 1.0 as written; do not reformat it:\n\n${jsonText}\nReport when it is saved.`,
  [{ tool: "write", args: { path: "data.json", content: jsonText } }],
  { files: {}, expected: { "data.json": jsonText } },
);

add(
  "web-read-search",
  ["web.read", "web.search"],
  "The local fixture server is at http://127.0.0.1:8765. Read its page as text, then search that URL for WEB-MARKER. Report the page marker. Do not change files.",
  [
    { tool: "read", args: { path: "http://127.0.0.1:8765" }, contains: "WEB-MARKER" },
    {
      tool: "search",
      args: { path: "http://127.0.0.1:8765", query: "WEB-MARKER" },
      contains: "WEB-MARKER",
    },
  ],
  {
    files: {},
    answer: "WEB-MARKER",
    setup: "web",
    resource: "web-port-8765",
  },
);

add(
  "json-structured-arguments",
  ["compose.json-text-structured-arguments"],
  'Pass source lists as JSON text strings. Read a.txt and b.txt together using path equal to the string ["a.txt","b.txt"]. Search those same two files for MARKER with that JSON-text path list. Then use diff with native before and after objects {"path":"a.txt"} and {"path":"b.txt"}; report the added marker. Finally diff again with native objects {"path":"a.txt","limit":0} and {"path":"b.txt","limit":0}; this must show no file lines. Read a.txt separately by its path, then reread that completed result by passing path as the JSON text string of an object containing its actual issued id. Obtain the id from the successful Read; do not invent it. Do not edit files.',
  [
    { tool: "read", args: { path: ["a.txt", "b.txt"] }, contains: "OLD-MARKER" },
    {
      tool: "search",
      args: { path: ["a.txt", "b.txt"], query: "MARKER" },
      contains: "b.txt",
    },
    {
      tool: "diff",
      args: { before: { path: "a.txt" }, after: { path: "b.txt" } },
      contains: "NEW-MARKER",
    },
    {
      tool: "diff",
      args: { before: { path: "a.txt", limit: 0 }, after: { path: "b.txt", limit: 0 } },
      excludes: "MARKER",
    },
    { tool: "read", args: { path: "a.txt" }, contains: "OLD-MARKER" },
    { tool: "read", reuse: reuse(4), contains: "OLD-MARKER" },
  ],
  { files: { "a.txt": "OLD-MARKER\n", "b.txt": "NEW-MARKER\n" }, answer: "NEW-MARKER" },
);
const literalJsonPath = '["a.txt","b.txt"]';
const legacyJsonSelector = '{"id":"checkout-5","feature":"legacyCheckout","retries":3}';
const stableJsonSelector = legacyJsonSelector.replace("legacyCheckout", "stableCheckout");
const jsonSelectorDocument = `[\n${legacyJsonSelector},\n{"id":"keep"}\n]\n`;
const jsonObjectSelector = /^\s*\{[\s\S]*"id"\s*:[\s\S]*"feature"\s*:[\s\S]*\}\s*$/u;
add(
  "json-literal-selectors",
  ["edit.literal-json-selectors", "read.literal-json-path"],
  `Read the single file whose literal filename is ${JSON.stringify(literalJsonPath)} by passing that exact string as path, not an array. Report its marker. Read replace.json, insert.json, source.json and target.json before editing. Use the complete JSON object text as each selector, including its braces and all keys; do not use line anchors, result references or smaller fragments. In replace.json, use ${JSON.stringify(legacyJsonSelector)} as both from and through and replace it with ${JSON.stringify(stableJsonSelector)}. In insert.json, use ${JSON.stringify(legacyJsonSelector)} as before and insert exactly one space. Copy the complete ${JSON.stringify(stableJsonSelector)} object from source.json using it as both from and through, replacing the object in target.json using ${JSON.stringify(legacyJsonSelector)} as both targetFrom and targetThrough. Keep adjacent commas and every other byte. Do not use Write.`,
  [
    { tool: "read", args: { path: literalJsonPath }, contains: "LITERAL-PATH-MARKER" },
    {
      tool: "replace",
      args: { path: "replace.json", from: jsonObjectSelector, through: jsonObjectSelector },
      exactText: ["from", "through"],
    },
    {
      tool: "insert",
      args: { path: "insert.json", before: jsonObjectSelector },
      exactText: ["before"],
    },
    {
      tool: "copy",
      args: {
        path: "source.json",
        target: "target.json",
        from: jsonObjectSelector,
        through: jsonObjectSelector,
        targetFrom: jsonObjectSelector,
        targetThrough: jsonObjectSelector,
      },
      exactText: ["from", "through", "targetFrom", "targetThrough"],
    },
  ],
  {
    forbiddenTools: ["write"],
    files: {
      [literalJsonPath]: "LITERAL-PATH-MARKER\n",
      "a.txt": "DECOY-A\n",
      "b.txt": "DECOY-B\n",
      "replace.json": jsonSelectorDocument,
      "insert.json": jsonSelectorDocument,
      "source.json": `[\n${stableJsonSelector}\n]\n`,
      "target.json": jsonSelectorDocument,
    },
    expected: {
      "replace.json": jsonSelectorDocument.replace("legacyCheckout", "stableCheckout"),
      "insert.json": `[\n ${legacyJsonSelector},\n{"id":"keep"}\n]\n`,
      "target.json": jsonSelectorDocument.replace("legacyCheckout", "stableCheckout"),
    },
    answer: "LITERAL-PATH-MARKER",
  },
);
{
  const preview = "// ⟦SLOT⟧";
  const notice = "⟦ ⟧";
  // Native batch children return acceptance; applied edits are reported in the parent receipt.
  const edits = (step: RouteStep, fallback = true): RouteStep[] => [
    { ...step, modes: ["direct"], ...(fallback ? { contains: notice } : { excludes: notice }) },
    {
      ...step,
      modes: ["codemode"],
      ...(fallback ? { parentContains: notice } : { parentExcludes: notice }),
    },
  ];
  add(
    "search-highlight-selectors",
    ["edit.search-highlight-selectors"],
    [
      "Search replace.txt for SLOT and wait for its result.",
      'Replace the full matching line fragment using at "// ⟦SLOT⟧" and text "// ⟦kept⟧". In direct mode take the fragment from the readable preview. In Codemode use the same marked fragment; the Search value gives you the unmarked line and match.',
      'Keep the ⟦ ⟧ characters in every selector below. In insert.txt, insert "inside " before "⟦edge⟧".',
      'Delete in delete.txt using after "⟦BEGIN⟧" and before "⟦END⟧". Keep the marker lines.',
      'Copy from source.txt using from "⟦START⟧" and through "⟦STOP⟧", replacing the range in copy.txt using targetFrom "⟦OPEN⟧" and targetThrough "⟦CLOSE⟧".',
      'Move from move.txt using at "⟦TRANSFER⟧", replacing the range in move-target.txt using targetAfter "⟦LEFT⟧" and targetBefore "⟦RIGHT⟧". Keep the target marker lines.',
      'Copy "⟦START⟧" from source.txt using at, replacing targetAt "⟦HOLE⟧" in copy-inline.txt.',
      'In literal.txt, Replace with at "⟦SLOT⟧" and text "matched". Only the literal bracketed fragment should change there.',
      'Attempt Replace in ambiguous.txt and missing.txt using at "⟦SLOT⟧" and text "wrong". Both must refuse; do not retry.',
      "In Codemode use a separate script for each edit attempt so its final receipt is easy to identify. Preserve all other bytes. Report which operations refused.",
    ].join("\n"),
    [
      {
        tool: "search",
        args: { path: "replace.txt", query: "SLOT" },
        contains: preview,
        modes: ["direct"],
      },
      {
        tool: "search",
        args: { path: "replace.txt", query: "SLOT" },
        scriptResult: { matches: { length: 1, 0: { text: "SLOT", lineText: "// SLOT" } } },
        modes: ["codemode"],
      },
      ...edits({ tool: "replace", args: { path: "replace.txt", at: preview } }).map(
        (step, index) => ({ ...step, after: [index] }),
      ),
      ...edits({ tool: "insert", args: { path: "insert.txt", before: "⟦edge⟧" } }),
      ...edits({ tool: "delete", args: { path: "delete.txt", after: "⟦BEGIN⟧", before: "⟦END⟧" } }),
      ...edits({
        tool: "copy",
        args: {
          path: "source.txt",
          from: "⟦START⟧",
          through: "⟦STOP⟧",
          target: "copy.txt",
          targetFrom: "⟦OPEN⟧",
          targetThrough: "⟦CLOSE⟧",
        },
      }),
      ...edits({
        tool: "move",
        args: {
          path: "move.txt",
          at: "⟦TRANSFER⟧",
          target: "move-target.txt",
          targetAfter: "⟦LEFT⟧",
          targetBefore: "⟦RIGHT⟧",
        },
      }),
      ...edits({
        tool: "copy",
        args: { path: "source.txt", at: "⟦START⟧", target: "copy-inline.txt", targetAt: "⟦HOLE⟧" },
      }),
      ...edits({ tool: "replace", args: { path: "literal.txt", at: "⟦SLOT⟧" } }, false),
      ...["ambiguous.txt", "missing.txt"].map((path) => ({
        tool: "replace",
        args: { path, at: "⟦SLOT⟧" },
        contains: notice,
        error: true,
      })),
    ],
    {
      forbiddenTools: ["write"],
      files: {
        "replace.txt": "// SLOT\n",
        "insert.txt": "left edge right\n",
        "delete.txt": "BEGIN\nold\nEND\n",
        "source.txt": "START\nbody\nSTOP\n",
        "copy.txt": "OPEN\nold\nCLOSE\n",
        "move.txt": "keep\nTRANSFER\n",
        "move-target.txt": "LEFT\nold\nRIGHT\n",
        "copy-inline.txt": "left HOLE right\n",
        "literal.txt": "SLOT\n⟦SLOT⟧\n",
        "ambiguous.txt": "SLOT\nSLOT\n",
        "missing.txt": "unrelated\n",
      },
      expected: {
        "replace.txt": "// ⟦kept⟧\n",
        "insert.txt": "left inside edge right\n",
        "delete.txt": "BEGIN\nEND\n",
        "copy.txt": "START\nbody\nSTOP\n",
        "move.txt": "keep\n",
        "move-target.txt": "LEFT\nTRANSFER\nRIGHT\n",
        "copy-inline.txt": "left START right\n",
        "literal.txt": "SLOT\nmatched\n",
      },
    },
  );
}

/** The same small tasks are used for every configured model. */
export const capabilityCases: CapabilityCase[] = cases;
